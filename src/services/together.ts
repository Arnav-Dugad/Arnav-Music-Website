/**
 * Listen together: a room (Cloudflare Durable Object over WebSocket) where the host's playback is
 * mirrored by everyone in it. The server stamps the host's state with its clock; each guest knows
 * its offset to that clock (ping/pong), so "where the song is now" is the same everywhere.
 * Guests who take over their own controls stop following until they tap Resync.
 */
import { create } from 'zustand'
import { currentTrack, player, usePlayer, useProgress } from '../state/player'
import { toast } from '../state/ui'
import { remember } from '../state/tracks'
import { useAuth } from '../state/auth'
import { ls } from '../lib/idb'
import type { Track } from '../lib/types'

export interface RoomMember { id: string; name: string; joinedAt: number; host: boolean }
interface RoomTrack { id: string; title: string; artist: string; album: string | null; playbackRef: string; durationMs: number | null; artworkUrl: string | null; variant?: string | null }
interface RoomState { track: RoomTrack | null; positionMs: number; playing: boolean; rate: number; at: number; upNext: RoomTrack[] }
export interface Reaction { key: string; emoji: string; name: string; mine: boolean; at: number }
export interface Suggestion { key: string; name: string; track: Track }

export const REACTIONS = ['❤️', '🔥', '😍', '🕺', '👏', '😭', '🤯', '🎶'] as const

interface TogetherStore {
  code: string | null
  status: 'idle' | 'connecting' | 'live' | 'reconnecting' | 'error'
  error: string | null
  you: string | null
  hostId: string | null
  members: RoomMember[]
  /** Guests: following the host (off once you use your own controls). */
  following: boolean
  room: RoomState | null
  reactions: Reaction[]
  suggestions: Suggestion[]
}

export const useTogether = create<TogetherStore>()(() => ({
  code: null, status: 'idle', error: null, you: null, hostId: null, members: [], following: true, room: null, reactions: [], suggestions: [],
}))
const st = () => useTogether.getState()
export const isHost = () => { const s = st(); return !!s.you && s.you === s.hostId }

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export function newRoomCode(): string {
  const b = crypto.getRandomValues(new Uint8Array(6))
  return [...b].map((x) => ALPHABET[x % ALPHABET.length]).join('')
}
export const validCode = (c: string) => /^[A-Z2-9]{6}$/.test(c)

export function listenerName(): string {
  const saved = ls.get<string>('arnav.listenerName', '')
  if (saved) return saved
  // Your Friends profile name, so friends recognise you in the room.
  const social = ls.get<string>('arnav.social.name', '')
  if (social) return social
  const u = useAuth.getState().user
  return (u?.displayName || u?.email?.split('@')[0] || 'Listener').slice(0, 40)
}
export function setListenerName(name: string) {
  ls.set('arnav.listenerName', name.slice(0, 40))
  send({ t: 'rename', name })
}

// ── Connection ──────────────────────────────────────────────────────────────
let ws: WebSocket | null = null
let wantCode: string | null = null
let retry = 0
let pingTimer: ReturnType<typeof setInterval> | null = null
let beatTimer: ReturnType<typeof setInterval> | null = null
let driftTimer: ReturnType<typeof setInterval> | null = null
/** Server clock minus ours, from the lowest-latency ping. */
let offset = 0
let bestRtt = Infinity
/** True while we change the player to follow the host (so it isn't read as the user's own action). */
let applying = false
/** When we last changed the player to follow (autoplay blocks and loads arrive a little later). */
let followedAt = 0
let unsubs: (() => void)[] = []

const serverNow = () => Date.now() + offset
function send(m: unknown) { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)) }

const roomTrack = (t: Track): RoomTrack => ({ id: t.id, title: t.title, artist: t.artist, album: t.album ?? null, playbackRef: t.playbackRef, durationMs: t.durationMs ?? null, artworkUrl: t.artworkUrl ?? null, variant: t.variant ?? null })
export const toTrack = (r: RoomTrack): Track => ({ id: r.id, title: r.title, artist: r.artist, album: r.album, playbackRef: r.playbackRef, durationMs: r.durationMs, artworkUrl: r.artworkUrl ?? `https://i.ytimg.com/vi/${r.playbackRef}/hqdefault.jpg`, genres: [], variant: (r.variant as Track['variant']) ?? undefined }) as Track

export function joinRoom(code: string) {
  const c = code.trim().toUpperCase()
  if (!validCode(c)) { toast('That room code isn’t valid'); return }
  leaveRoom(false)
  wantCode = c
  try { sessionStorage.setItem('arnav.room', c) } catch { /* storage blocked */ }
  retry = 0
  useTogether.setState({ code: c, status: 'connecting', error: null, following: true, reactions: [], suggestions: [], room: null })
  connect()
  watchPlayer()
}

function connect() {
  if (!wantCode) return
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const sock = new WebSocket(`${proto}://${location.host}/api/room/${wantCode}?name=${encodeURIComponent(listenerName())}`)
  ws = sock
  sock.onopen = () => {
    retry = 0
    bestRtt = Infinity
    ping()
    if (pingTimer) clearInterval(pingTimer)
    pingTimer = setInterval(ping, 10_000)
  }
  sock.onmessage = (e) => { try { onMessage(JSON.parse(e.data as string)) } catch { /* ignore */ } }
  sock.onclose = (e) => {
    if (ws !== sock) return
    ws = null
    if (!wantCode) return
    if (e.code === 1008 || retry > 6) { useTogether.setState({ status: 'error', error: 'Lost the room. Try joining again.' }); return }
    useTogether.setState({ status: 'reconnecting' })
    setTimeout(connect, Math.min(8000, 600 * 2 ** retry++))
  }
}

function ping() { send({ t: 'ping', c: Date.now() }) }

export function leaveRoom(announce = true) {
  wantCode = null
  if (announce) { try { sessionStorage.removeItem('arnav.room') } catch { /* storage blocked */ } }
  const s = ws
  ws = null
  try { s?.close(1000) } catch { /* ignore */ }
  for (const t of [pingTimer, beatTimer, driftTimer]) if (t) clearInterval(t)
  pingTimer = beatTimer = driftTimer = null
  unsubs.forEach((u) => u())
  unsubs = []
  if (st().code && announce) toast('You left the room')
  useTogether.setState({ code: null, status: 'idle', you: null, hostId: null, members: [], room: null, reactions: [], suggestions: [], following: true })
}

// ── Messages ────────────────────────────────────────────────────────────────
function onMessage(m: Record<string, unknown>) {
  switch (m.t) {
    case 'welcome': {
      offset = Number(m.serverNow) - Date.now()
      useTogether.setState({ status: 'live', you: String(m.you), hostId: (m.hostId as string) ?? null, members: (m.members as RoomMember[]) ?? [] })
      const room = m.state as RoomState
      useTogether.setState({ room })
      if (isHost()) { if (room.track && !currentTrack()) followHost(room); else broadcast() }
      else followHost(room)
      return
    }
    case 'pong': {
      const rtt = Date.now() - Number(m.c)
      if (rtt >= 0 && rtt <= bestRtt) { bestRtt = rtt; offset = Number(m.serverNow) - (Number(m.c) + rtt / 2) }
      return
    }
    case 'members': {
      const wasHost = isHost()
      useTogether.setState({ members: (m.members as RoomMember[]) ?? [], hostId: (m.hostId as string) ?? null })
      if (!wasHost && isHost()) { toast('You’re the host now — everyone follows your music'); broadcast() }
      return
    }
    case 'host': {
      useTogether.setState({ hostId: String(m.id) })
      if (isHost()) { toast('You’re the host now'); broadcast() }
      return
    }
    case 'state': {
      const room = m.state as RoomState
      useTogether.setState({ room })
      if (!isHost() && st().following) followHost(room)
      return
    }
    case 'react': {
      const r: Reaction = { key: `${m.at}-${m.from}-${Math.random()}`, emoji: String(m.emoji), name: String(m.name), mine: m.from === st().you, at: Date.now() }
      useTogether.setState({ reactions: [...st().reactions.filter((x) => Date.now() - x.at < 5000), r].slice(-40) })
      return
    }
    case 'suggest': {
      const t = toTrack(m.track as RoomTrack)
      remember(t)
      const s: Suggestion = { key: `${Date.now()}-${m.from}`, name: String(m.name), track: t }
      useTogether.setState({ suggestions: [s, ...st().suggestions].slice(0, 10) })
      toast(`${s.name} suggests “${t.title}”`, { label: 'Play next', run: () => { player().playNext([t]); dismissSuggestion(s.key) } })
      return
    }
  }
}

/** Where the host's song is right now. */
function expectedPosition(room: RoomState): number {
  if (!room.playing) return room.positionMs
  return room.positionMs + Math.max(0, serverNow() - room.at) * (room.rate || 1)
}

function followHost(room: RoomState) {
  if (!room.track) return
  applying = true
  followedAt = Date.now()
  try {
    const p = player()
    const cur = currentTrack()
    if (cur?.playbackRef !== room.track.playbackRef) {
      const t = toTrack(room.track)
      remember(t)
      p.play([t, ...room.upNext.map(toTrack)], 0, { context: 'Listening together' })
      // The new video needs a moment to start; align once it plays.
      pendingSeek = true
    } else {
      if (room.playing !== p.wantPlaying) p.setPlaying(room.playing)
      alignPosition(room)
    }
    if (Math.abs((p.rate || 1) - (room.rate || 1)) > 0.01) p.setRate(room.rate || 1)
  } finally {
    setTimeout(() => { applying = false }, 50)
  }
}

let pendingSeek = false
function alignPosition(room: RoomState) {
  const want = expectedPosition(room)
  const have = useProgress.getState().position
  // Small drift is fine (and seeking costs a rebuffer); fix anything audible.
  if (Math.abs(want - have) > 1200) { applying = true; player().seek(want + (room.playing ? 250 : 0)); setTimeout(() => { applying = false }, 50) }
}

// ── Host broadcast / guest follow ───────────────────────────────────────────
function broadcast() {
  if (!isHost()) return
  const p = usePlayer.getState()
  const t = currentTrack()
  send({
    t: 'state',
    track: t ? roomTrack(t) : null,
    positionMs: useProgress.getState().position,
    playing: p.wantPlaying,
    rate: p.rate,
    upNext: p.queue.slice(p.index + 1, p.index + 4).map((q) => roomTrack(q.track)),
  })
}

function watchPlayer() {
  unsubs.forEach((u) => u())
  unsubs = [
    usePlayer.subscribe((s, prev) => {
      const changed = s.queue[s.index]?.key !== prev.queue[prev.index]?.key || s.wantPlaying !== prev.wantPlaying || s.seekRequest !== prev.seekRequest || s.rate !== prev.rate
      if (!changed || !st().code) return
      if (isHost()) { setTimeout(broadcast, s.seekRequest !== prev.seekRequest ? 300 : 0); return }
      // A guest using their own controls stops following.
      if (!applying && Date.now() - followedAt > 4000 && st().following) { useTogether.setState({ following: false }); toast('You’re steering your own music — tap Resync to follow the room again') }
    }),
    usePlayer.subscribe((s, prev) => {
      // The followed song started: line up with the host.
      if (pendingSeek && s.isPlaying && !prev.isPlaying && !isHost()) {
        pendingSeek = false
        const room = st().room
        if (room) alignPosition(room)
      }
    }),
  ]
  if (beatTimer) clearInterval(beatTimer)
  beatTimer = setInterval(() => { if (isHost() && usePlayer.getState().wantPlaying) broadcast() }, 5000)
  if (driftTimer) clearInterval(driftTimer)
  driftTimer = setInterval(() => {
    const room = st().room
    if (!room || isHost() || !st().following || pendingSeek || !usePlayer.getState().isPlaying) return
    if (currentTrack()?.playbackRef === room.track?.playbackRef) alignPosition(room)
  }, 2500)
}

export function resync() {
  useTogether.setState({ following: true })
  const room = st().room
  if (room) followHost(room)
  // A tap is what browsers need before they play sound: start right away.
  if (room?.playing) { applying = true; player().setPlaying(true); setTimeout(() => { applying = false }, 50) }
}

export function react(emoji: string) { send({ t: 'react', emoji }) }
export function suggest(t: Track) {
  if (!st().code) return
  if (isHost()) { player().playNext([t]); toast('Added to play next for the room'); return }
  send({ t: 'suggest', track: roomTrack(t) })
  toast(`Suggested “${t.title}” to the host`)
}
export function makeHost(id: string) { send({ t: 'makeHost', id }) }
export function dismissSuggestion(key: string) { useTogether.setState({ suggestions: st().suggestions.filter((s) => s.key !== key) }) }
export const roomLink = (code: string) => `${location.origin}/together/${code}`

/** A reload keeps you in your room (this tab only). */
export function rejoinAfterReload() {
  let c: string | null = null
  try { c = sessionStorage.getItem('arnav.room') } catch { /* storage blocked */ }
  if (c && validCode(c) && !st().code) joinRoom(c)
}
