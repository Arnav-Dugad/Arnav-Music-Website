/**
 * Friends: profiles, friend requests, live "listening now", listen-along, the inbox (song shares,
 * room invites, reactions), friends' activity and charts, taste match and Blend.
 *
 * The edge keeps it all (worker/social.ts). Your profile lives on this device (id + secret key);
 * signing in links it to your account so it follows you to your other devices. One WebSocket
 * carries presence both ways: what you play reaches your friends within a second.
 */
import { create } from 'zustand'
import { currentTrack, player, usePlayer, useProgress } from '../state/player'
import { toast } from '../state/ui'
import { remember, trackRegistry } from '../state/tracks'
import { lib, liveEvents, useLibrary } from '../state/library'
import { useAuth } from '../state/auth'
import { useTogether } from './together'
import { ls } from '../lib/idb'
import { topArtists, topTracks } from '../lib/taste'
import { artistKey, type Track } from '../lib/types'

export interface Person { id: string; handle: string; name: string; avatar: string | null; color: string; bio: string | null }
export interface SocialTrack { id: string; title: string; artist: string; album: string | null; playbackRef: string; durationMs: number | null; artworkUrl: string | null; variant?: string | null }
export interface NowPlaying { track: SocialTrack | null; positionMs: number; playing: boolean; at: number; room: string | null }
export interface Taste { artists: { name: string; weight: number; artwork: string | null }[]; tracks: { track: SocialTrack; plays: number }[]; minutes: number | null; at: number }
export type Relation = 'me' | 'none' | 'friends' | 'requested' | 'incoming' | 'blocked'
export interface PersonView extends Person { relation: Relation; online: boolean; now: NowPlaying | null; taste: Taste | null; listeners: number; seen: number | null }
export interface Me extends Person { code: string; privacy: 'everyone' | 'friends' | 'off'; linked: boolean }
export interface InboxItem { n: number; kind: 'share' | 'invite'; from: Person | null; to?: Person | null; body: { track?: SocialTrack | null; note?: string | null; room?: string }; at: number; read: boolean; reaction: string | null; mine: boolean }

interface SocialStore {
  status: 'none' | 'loading' | 'ready' | 'error' | 'unavailable'
  me: Me | null
  friends: PersonView[]
  incoming: Person[]
  outgoing: Person[]
  unread: number
  /** Live presence by friend id (fresher than `friends[].now`). */
  presence: Record<string, { online: boolean; now: NowPlaying | null }>
  connected: boolean
  /** Listening along with this friend. */
  following: string | null
  /** Friends listening along with you right now. */
  listeners: Person[]
  inbox: InboxItem[] | null
  sent: InboxItem[]
  /** Your public playlists (`src` = the playlist's id in your library). null until loaded. */
  pubs: PublicSummary[] | null
}

/** A public playlist, as listed on a profile or in your own library. */
export interface PublicSummary { id: string; src: string; title: string; count: number; art: string | null; updated: number; saves: number }
export interface PublicPlaylist { id: string; title: string; description: string | null; tracks: SocialTrack[]; count: number; art: string | null; created: number; updated: number; saves: number }

export const useSocial = create<SocialStore>()(() => ({
  status: 'none', me: null, friends: [], incoming: [], outgoing: [], unread: 0, presence: {}, connected: false, following: null, listeners: [], inbox: null, sent: [], pubs: null,
}))
const st = () => useSocial.getState()

// ── Identity + API ──────────────────────────────────────────────────────────
interface Identity { id: string; key: string }
const ID_KEY = 'arnav.social.v1'
const identity = () => ls.get<Identity | null>(ID_KEY, null)
export const hasProfile = () => !!identity()

export class SocialError extends Error { constructor(public code: string, message: string, public status = 0) { super(message) } }

async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const id = identity()
  const r = await fetch(`/api/social/${path}`, {
    method: init.method ?? 'GET',
    headers: { 'content-type': 'application/json', ...(id ? { 'x-social': `${id.id}.${id.key}` } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  }).catch(() => null)
  if (!r) throw new SocialError('offline', 'You appear to be offline.')
  const data = (await r.json().catch(() => ({}))) as Record<string, unknown>
  if (!r.ok) {
    if (r.status === 501) useSocial.setState({ status: 'unavailable' })
    throw new SocialError(String(data.error ?? 'failed'), String(data.message ?? 'Something went wrong — try again.'), r.status)
  }
  return data as T
}

interface MePayload { profile: Me; friends: PersonView[]; incoming: Person[]; outgoing: Person[]; unread: number }
function applyMe(d: MePayload) {
  const presence = { ...st().presence }
  for (const f of d.friends) presence[f.id] = { online: f.online, now: f.now }
  useSocial.setState({ me: d.profile, friends: d.friends, incoming: d.incoming, outgoing: d.outgoing, unread: d.unread, presence, status: 'ready' })
  ls.set('arnav.social.name', d.profile.name)
}

async function idToken(): Promise<string | null> {
  if (useAuth.getState().status !== 'signedIn') return null
  try {
    const { firebaseAuth } = await import('../lib/firebase')
    return (await firebaseAuth().currentUser?.getIdToken()) ?? null
  } catch { return null }
}

/** Creates your profile (signed in: linked to your account, or your existing profile is used). */
export async function createProfile(name: string, handle?: string): Promise<void> {
  const r = await api<MePayload & { id: string; key: string }>('register', { method: 'POST', body: { name, handle, idToken: await idToken() } })
  ls.set(ID_KEY, { id: r.id, key: r.key })
  applyMe(r)
  connect()
  void uploadTaste(true)
}

export async function refresh(): Promise<void> {
  if (!identity()) { useSocial.setState({ status: 'none' }); return }
  try { applyMe(await api<MePayload>('me')) } catch (e) {
    if (e instanceof SocialError && e.status === 401) { ls.del(ID_KEY); useSocial.setState({ status: 'none', me: null, friends: [] }); return }
    if (st().status !== 'ready') useSocial.setState({ status: e instanceof SocialError && e.code === 'social_unavailable' ? 'unavailable' : 'error' })
  }
}

let started = false
/** On app start: load your profile, go live, keep presence and taste up to date. */
export function startSocial() {
  if (started) return
  started = true
  if (identity()) { useSocial.setState({ status: 'loading' }); void refresh().then(() => { connect(); void linkIfSignedIn() }) }
  useAuth.subscribe((s, p) => { if (s.status === 'signedIn' && p.status !== 'signedIn') void linkIfSignedIn() })
  watchPlayback()
  watchPublicPlaylists()
  setInterval(() => void uploadTaste(), 30 * 60_000)
}

/** Keeps public copies in step with your playlists: edit a public playlist and its link updates. */
function watchPublicPlaylists() {
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  if (identity()) void loadPubs().catch(() => undefined)
  useLibrary.subscribe((s, prev) => {
    if (s.playlists === prev.playlists) return
    for (const pub of st().pubs ?? []) {
      const now = s.playlists[pub.src]
      const was = prev.playlists[pub.src]
      if (!now || now === was) continue
      if (now.deleted) { void unpublishPlaylist(pub.src).catch(() => undefined); continue }
      clearTimeout(timers.get(pub.src))
      timers.set(pub.src, setTimeout(() => {
        const p = useLibrary.getState().playlists[pub.src]
        if (!p || p.deleted) return
        void publishPlaylist(pub.src, { title: p.name, description: p.description, art: p.artworkUrl, tracks: trackRegistry.many(p.trackIds) }).catch(() => undefined)
      }, 5000))
    }
  })
}

async function linkIfSignedIn() {
  if (!identity() || st().me?.linked) return
  const token = await idToken()
  if (!token) return
  try {
    const r = await api<MePayload & { id: string; key?: string; switched?: boolean }>('link', { method: 'POST', body: { idToken: token } })
    if (r.key) { ls.set(ID_KEY, { id: r.id, key: r.key }); reconnect() }
    applyMe(r)
    if (r.switched) toast(`Welcome back, ${r.profile.name} — your friends are here`)
  } catch { /* try again next sign-in */ }
}

export async function updateProfile(p: Partial<Pick<Me, 'handle' | 'name' | 'bio' | 'color' | 'privacy' | 'avatar'>>) {
  applyMe(await api<MePayload>('me', { method: 'PATCH', body: p }))
}

export async function findPeople(q: string): Promise<PersonView[]> {
  return (await api<{ people: PersonView[] }>(`find?q=${encodeURIComponent(q)}`)).people
}
export async function findByCode(code: string): Promise<PersonView | null> {
  return (await api<{ people: PersonView[] }>(`find?code=${encodeURIComponent(code)}`)).people[0] ?? null
}
export async function profileOf(handleOrId: string) {
  return api<{ person: PersonView; recent: { at: number; track: SocialTrack }[]; mutual: number; playlists?: PublicSummary[] }>(`u/${encodeURIComponent(handleOrId)}`)
}

// ── Public playlists ────────────────────────────────────────────────────────
export const publicLink = (id: string) => `${location.origin}/p/${id}`
export const pubFor = (src: string) => st().pubs?.find((p) => p.src === src) ?? null

export async function loadPubs(): Promise<PublicSummary[]> {
  if (!identity()) { useSocial.setState({ pubs: [] }); return [] }
  const items = (await api<{ items: PublicSummary[] }>('pubs')).items
  useSocial.setState({ pubs: items })
  return items
}

/**
 * Makes one of your playlists public (or updates its public copy). Without a Friends profile yet,
 * one is created for you (linked to your account when you're signed in).
 */
export async function publishPlaylist(src: string, p: { title: string; description?: string | null; tracks: Track[]; art?: string | null }): Promise<string> {
  if (!identity()) {
    const name = useAuth.getState().user?.displayName?.trim() || 'Listener'
    await createProfile(name)
  }
  const r = await api<{ id: string; updated: number }>('publish', { method: 'POST', body: { src, title: p.title, description: p.description ?? null, art: p.art ?? null, tracks: p.tracks.slice(0, 500).map(socialTrack) } })
  const prev = (st().pubs ?? []).filter((x) => x.src !== src)
  useSocial.setState({ pubs: [{ id: r.id, src, title: p.title, count: Math.min(500, p.tracks.length), art: p.art ?? p.tracks[0]?.artworkUrl ?? null, updated: r.updated, saves: pubFor(src)?.saves ?? 0 }, ...prev] })
  return r.id
}

export async function unpublishPlaylist(src: string): Promise<void> {
  const r = await api<{ items: PublicSummary[] }>('unpublish', { method: 'POST', body: { src } })
  useSocial.setState({ pubs: r.items })
}

/** Anyone's public playlist, by its link id (no profile needed). */
export async function publicPlaylist(id: string): Promise<{ playlist: PublicPlaylist; owner: Person }> {
  return api<{ playlist: PublicPlaylist; owner: Person }>(`pl/${encodeURIComponent(id)}`)
}
export function markSaved(id: string) { if (identity()) void api('saved', { method: 'POST', body: { id } }).catch(() => undefined) }

/** Sends a request (or accepts theirs). With an invite code you're friends straight away. */
export async function addFriend(to: { id?: string; handle?: string; code?: string }): Promise<'friends' | 'requested'> {
  const r = await api<{ state: 'friends' | 'requested' }>('friend', { method: 'POST', body: to })
  await refresh()
  return r.state
}
export async function respond(id: string, accept: boolean) { applyMe(await api<MePayload>('respond', { method: 'POST', body: { id, accept } })) }
export async function unfriend(id: string) { if (st().following === id) stopListeningAlong(); applyMe(await api<MePayload>('unfriend', { method: 'POST', body: { id } })) }
export async function block(id: string) { if (st().following === id) stopListeningAlong(); applyMe(await api<MePayload>('block', { method: 'POST', body: { id } })) }

/** Deletes your Friends profile everywhere (friends, inbox, what you played). */
export async function deleteProfile() {
  await api('delete', { method: 'POST' })
  ls.del(ID_KEY)
  ls.del('arnav.social.name')
  const s = ws
  ws = null
  try { s?.close() } catch { /* closed */ }
  useSocial.setState({ status: 'none', me: null, friends: [], incoming: [], outgoing: [], unread: 0, presence: {}, connected: false, following: null, listeners: [], inbox: null, sent: [] })
}

export const inviteLink = (code: string) => `${location.origin}/add/${code}`
export const profileLink = (handle: string) => `${location.origin}/u/${handle}`

// ── Inbox ───────────────────────────────────────────────────────────────────
export async function loadInbox() {
  const r = await api<{ items: InboxItem[]; sent: InboxItem[] }>('inbox')
  useSocial.setState({ inbox: r.items, sent: r.sent })
}
export async function markRead() {
  if (!st().unread && !st().inbox?.some((i) => !i.read)) return
  useSocial.setState({ unread: 0, inbox: st().inbox?.map((i) => ({ ...i, read: true })) ?? null })
  await api('read', { method: 'POST' }).catch(() => undefined)
}
export async function reactToItem(n: number, emoji: string | null) {
  useSocial.setState({ inbox: st().inbox?.map((i) => (i.n === n ? { ...i, reaction: emoji, read: true } : i)) ?? null })
  await api('react', { method: 'POST', body: { n, emoji: emoji ?? '' } })
}

export const socialTrack = (t: Track): SocialTrack => ({ id: t.id, title: t.title, artist: t.artist, album: t.album ?? null, playbackRef: t.playbackRef, durationMs: t.durationMs ?? null, artworkUrl: t.artworkUrl ?? null, variant: t.variant ?? null })
export const asTrack = (r: SocialTrack): Track => {
  const t = trackRegistry.get(r.id) ?? ({ id: r.id, title: r.title, artist: r.artist, album: r.album, playbackRef: r.playbackRef, durationMs: r.durationMs, artworkUrl: r.artworkUrl ?? `https://i.ytimg.com/vi/${r.playbackRef}/hqdefault.jpg`, genres: [], variant: (r.variant as Track['variant']) ?? undefined } as Track)
  remember(t)
  return t
}

export async function shareWith(ids: string[], t: Track, note: string) {
  const r = await api<{ sent: number }>('send', { method: 'POST', body: { to: ids, kind: 'share', track: socialTrack(t), note } })
  return r.sent
}
export async function inviteToRoom(ids: string[], room: string, note = '') {
  const t = currentTrack()
  return (await api<{ sent: number }>('send', { method: 'POST', body: { to: ids, kind: 'invite', room, track: t ? socialTrack(t) : null, note } })).sent
}

export async function friendsFeed() { return (await api<{ items: { who: Person; at: number; track: SocialTrack }[] }>('feed')).items }
export async function friendsCharts() { return api<{ items: { track: SocialTrack; plays: number; listeners: Person[] }[]; people: number }>('charts') }

// ── Live connection ─────────────────────────────────────────────────────────
let ws: WebSocket | null = null
let retry = 0
let offset = 0
let heartbeat: ReturnType<typeof setInterval> | null = null
let pingTimer: ReturnType<typeof setInterval> | null = null
const serverNow = () => Date.now() + offset

function send(m: unknown) { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)) }

/** Last time anything arrived on the socket (a silent, half-dead connection is closed and replaced). */
let lastHeard = 0
let connecting = false
let retryTimer: ReturnType<typeof setTimeout> | null = null
/** The profile was rejected (deleted elsewhere): stop retrying until it changes. */
let rejected = false

async function connect() {
  if (ws || connecting || !identity() || rejected || st().status === 'unavailable') return
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null }
  connecting = true
  let ticket: string
  try {
    ticket = (await api<{ ticket: string }>('ticket', { method: 'POST' })).ticket
  } catch (e) {
    connecting = false
    if (e instanceof SocialError && e.status === 401) { rejected = true; return }
    schedule()
    return
  }
  connecting = false
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const sock = new WebSocket(`${proto}://${location.host}/api/social/ws?ticket=${ticket}`)
  ws = sock
  sock.onopen = () => {
    retry = 0
    lastHeard = Date.now()
    useSocial.setState({ connected: true })
    publish()
    if (pingTimer) clearInterval(pingTimer)
    let beats = 0
    pingTimer = setInterval(() => {
      // A plain keep-alive (the hub answers it without waking up); every 10th also re-syncs the clock.
      if (++beats % 10 === 0) send({ t: 'ping', c: Date.now() })
      else if (ws?.readyState === WebSocket.OPEN) ws.send('{"t":"ping"}')
      if (Date.now() - lastHeard > 70_000) { try { sock.close() } catch { /* closed */ } }
    }, 25_000)
    if (st().following) send({ t: 'follow', id: st().following })
  }
  sock.onmessage = (e) => { lastHeard = Date.now(); try { onMessage(JSON.parse(e.data as string)) } catch { /* ignore */ } }
  sock.onclose = () => {
    if (ws !== sock) return
    ws = null
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null }
    useSocial.setState({ connected: false })
    schedule()
  }
}
/** Backs off 1 s → 30 s with jitter (so a server restart isn't met by every app at the same instant). */
function schedule() {
  if (!identity() || rejected || retryTimer) return
  const wait = Math.min(30_000, 1000 * 2 ** retry++) * (0.75 + Math.random() * 0.5)
  retryTimer = setTimeout(() => { retryTimer = null; void connect() }, wait)
}
function reconnect() { rejected = false; const s = ws; ws = null; try { s?.close() } catch { /* closed */ } retry = 0; void connect() }

// Back online, or back in the app after the phone slept: reconnect straight away instead of waiting
// out the backoff, and check a socket that may have died while we were away.
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => { retry = 0; if (!ws) void connect() })
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return
    if (!ws) { retry = 0; void connect(); return }
    if (Date.now() - lastHeard > 40_000) send({ t: 'ping', c: Date.now() })
  })
}

function nameOf(id: string) { return st().friends.find((f) => f.id === id)?.name ?? 'A friend' }

function notify(title: string, body: string) {
  try {
    if (document.hidden && 'Notification' in window && Notification.permission === 'granted') new Notification(title, { body, icon: '/icons/icon-192.png', silent: false })
  } catch { /* not supported */ }
}

function onMessage(m: Record<string, unknown>) {
  switch (m.t) {
    case 'hello': offset = Number(m.serverNow) - Date.now(); return
    case 'pong': { const rtt = Date.now() - Number(m.c); if (rtt >= 0 && rtt < 2000) offset = Number(m.serverNow) - (Number(m.c) + rtt / 2); return }
    case 'snapshot': {
      const presence = { ...st().presence }
      for (const p of (m.presence as { id: string; online: boolean; now: NowPlaying | null }[]) ?? []) presence[p.id] = { online: p.online, now: p.now }
      useSocial.setState({ presence })
      return
    }
    case 'presence': {
      const id = String(m.id)
      const now = (m.now as NowPlaying | null) ?? null
      useSocial.setState({ presence: { ...st().presence, [id]: { online: m.online === true, now } } })
      if (st().following === id) followFriend(now)
      return
    }
    case 'request': {
      const who = m.who as Person
      useSocial.setState({ incoming: [who, ...st().incoming.filter((p) => p.id !== who.id)] })
      toast(`${who.name} (@${who.handle}) wants to be friends`, { label: 'Accept', run: () => void respond(who.id, true).then(() => toast(`You and ${who.name} are friends now`)) })
      notify('New friend request', `${who.name} wants to be friends`)
      return
    }
    case 'friends': {
      const who = m.who as Person
      toast(`You and ${who.name} are friends now 🎉`)
      notify('New friend', `You and ${who.name} are friends now`)
      void refresh()
      return
    }
    case 'refresh': void refresh(); return
    case 'inbox': {
      const item = m.item as InboxItem
      useSocial.setState({ unread: st().unread + 1, inbox: st().inbox ? [item, ...st().inbox!] : null })
      if (item.kind === 'invite' && item.body.room) {
        toast(`${item.from?.name ?? 'A friend'} invited you to listen together`, { label: 'Join', run: () => openRoom(item.body.room!) })
        notify('Listen together?', `${item.from?.name ?? 'A friend'} invited you to their room`)
      } else if (item.body.track) {
        const t = asTrack(item.body.track)
        toast(`${item.from?.name ?? 'A friend'} sent you “${t.title}”`, { label: 'Play', run: () => player().play([t], 0, { context: `From ${item.from?.name ?? 'a friend'}` }) })
        notify(`${item.from?.name ?? 'A friend'} sent you a song`, `${t.title} · ${t.artist}${item.body.note ? ` — “${item.body.note}”` : ''}`)
      }
      return
    }
    case 'reaction': {
      const who = m.who as Person
      const t = (m.body as { track?: SocialTrack })?.track
      toast(`${who.name} reacted ${String(m.emoji)} to ${t ? `“${t.title}”` : 'your share'}`)
      return
    }
    case 'listeners': {
      const people = (m.people as Person[]) ?? []
      const before = new Set(st().listeners.map((p) => p.id))
      const joined = people.filter((p) => !before.has(p.id))
      useSocial.setState({ listeners: people })
      if (joined.length) toast(`${joined.map((p) => p.name).join(', ')} ${joined.length > 1 ? 'are' : 'is'} listening along with you 🎧`)
      restartHeartbeat()
      return
    }
    case 'follow': {
      if (m.ok !== true) { useSocial.setState({ following: null }); toast(`${nameOf(String(m.id))} isn’t sharing what they play right now`); return }
      followFriend((m.now as NowPlaying | null) ?? null, true)
      return
    }
    case 'wave': {
      const who = m.who as Person
      toast(`${who.name} says ${String(m.emoji)}`, { label: 'Wave back', run: () => wave(who.id) })
      notify(`${who.name} says ${String(m.emoji)}`, 'Tap to listen together')
      return
    }
  }
}

/** Opens a listening room's page (which joins it) from anywhere, without a router handle. */
export function openRoom(code: string) {
  history.pushState(null, '', `/together/${code}`)
  dispatchEvent(new PopStateEvent('popstate'))
}

export function wave(id: string, emoji = '👋') { send({ t: 'wave', id, emoji }); toast(`Waved at ${nameOf(id)} ${emoji}`) }

// ── Publishing what you play ────────────────────────────────────────────────
let lastSent = ''
function publish() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return
  const t = currentTrack()
  const p = usePlayer.getState()
  const room = useTogether.getState().status === 'live' ? useTogether.getState().code : null
  const msg = { t: 'np', track: t ? socialTrack(t) : null, positionMs: Math.round(useProgress.getState().position), playing: p.wantPlaying && !!t, room }
  lastSent = `${t?.id}|${msg.playing}`
  send(msg)
}
let debounce: ReturnType<typeof setTimeout> | null = null
const publishSoon = (ms = 350) => { if (debounce) clearTimeout(debounce); debounce = setTimeout(publish, ms) }

function restartHeartbeat() {
  if (heartbeat) clearInterval(heartbeat)
  // Every 20 s while playing — every 5 s while friends listen along, so they stay in step.
  heartbeat = setInterval(() => { if (usePlayer.getState().wantPlaying || `${currentTrack()?.id}|false` !== lastSent) publish() }, st().listeners.length ? 5000 : 20_000)
}

function watchPlayback() {
  usePlayer.subscribe((s, prev) => {
    const changed = s.queue[s.index]?.key !== prev.queue[prev.index]?.key || s.wantPlaying !== prev.wantPlaying || s.seekRequest !== prev.seekRequest
    if (!changed) return
    if (ws) publishSoon(s.seekRequest !== prev.seekRequest ? 500 : 350)
    // Your own controls while listening along: you've gone your own way.
    if (st().following && !applying && Date.now() - followedAt > 4000) {
      stopListeningAlong(false)
      toast('You’re steering your own music now — listen along again any time')
    }
  })
  // Joining or leaving a room shows on your friends' cards ("in a room — join").
  useTogether.subscribe((s, p) => {
    if (s.status !== p.status || s.code !== p.code) publishSoon(600)
    // A listening room keeps you in step from now on: listening along ends.
    if (s.code && s.code !== p.code && st().following) stopListeningAlong(false)
  })
  restartHeartbeat()
  document.addEventListener('visibilitychange', () => { if (!document.hidden && identity() && !ws) void connect() })
}

// ── Listen along ────────────────────────────────────────────────────────────
let applying = false
let followedAt = 0

/** Follows a friend's playback live (no room needed): same song, same moment, until you take over. */
export async function listenAlong(id: string) {
  const pres = st().presence[id]
  // They're in a listening room: join it — rooms keep everyone in step both ways.
  if (pres?.now?.room) {
    openRoom(pres.now.room)
    toast(`Joining ${nameOf(id)}’s room`)
    return
  }
  useSocial.setState({ following: id })
  send({ t: 'follow', id })
  if (!ws) void connect()
  toast(`Listening along with ${nameOf(id)} 🎧`)
}
export function stopListeningAlong(announce = true) {
  const id = st().following
  if (!id) return
  useSocial.setState({ following: null })
  send({ t: 'follow', id: null })
  if (announce) toast(`Stopped listening along with ${nameOf(id)}`)
}

function followFriend(now: NowPlaying | null, first = false) {
  if (!now?.track) { if (first) toast(`${nameOf(st().following ?? '')} isn’t playing anything — you’ll hear their next song`); return }
  const p = player()
  const want = now.playing ? now.positionMs + Math.max(0, serverNow() - now.at) : now.positionMs
  applying = true
  followedAt = Date.now()
  try {
    if (currentTrack()?.playbackRef !== now.track.playbackRef) {
      p.play([asTrack(now.track)], 0, { context: `Listening along with ${nameOf(st().following ?? '')}` })
      // Line up once the video has started.
      const unsub = usePlayer.subscribe((s) => {
        if (!s.isPlaying) return
        unsub()
        const fresh = st().presence[st().following ?? '']?.now ?? now
        const pos = fresh.playing ? fresh.positionMs + Math.max(0, serverNow() - fresh.at) : fresh.positionMs
        applying = true
        followedAt = Date.now()
        if (Math.abs(pos - useProgress.getState().position) > 1500) p.seek(pos + 300)
        setTimeout(() => { applying = false }, 80)
      })
      setTimeout(unsub, 20_000)
    } else {
      if (now.playing !== usePlayer.getState().wantPlaying) p.setPlaying(now.playing)
      if (Math.abs(want - useProgress.getState().position) > 2500) p.seek(want + (now.playing ? 250 : 0))
    }
  } finally {
    setTimeout(() => { applying = false }, 80)
  }
}

// ── Taste (top artists and songs, shared with friends for match and Blend) ──
const TASTE_AT = 'arnav.social.tasteAt'
export async function uploadTaste(force = false) {
  if (!identity() || st().status !== 'ready') return
  if (!force && Date.now() - ls.get<number>(TASTE_AT, 0) < 6 * 3600_000) return
  const events = liveEvents()
  const since = Date.now() - 60 * 86_400_000
  const artists = topArtists(events, (id) => trackRegistry.get(id), since).slice(0, 30)
  const tracks = topTracks(events, since).slice(0, 40).map((s) => ({ t: trackRegistry.get(s.id), plays: s.plays })).filter((x) => x.t && x.t.playbackRef)
  // Liked songs count too when there's little history yet.
  const liked = Object.values(lib().likes).filter((l) => !l.deleted).sort((x, y) => y.likedAt - x.likedAt).slice(0, 30).map((l) => trackRegistry.get(l.trackId)).filter((t): t is Track => !!t && !!t.playbackRef)
  const weekMs = events.filter((e) => e.startedAt > Date.now() - 7 * 86_400_000).reduce((a, e) => a + e.listenedMs, 0)
  const taste = {
    artists: artists.map((a) => ({ name: a.name, weight: Math.round(a.ms / 1000), artwork: a.artwork ?? null })),
    tracks: [...tracks.map((x) => ({ track: socialTrack(x.t!), plays: x.plays })), ...liked.filter((t) => !tracks.some((x) => x.t!.id === t.id)).map((t) => ({ track: socialTrack(t), plays: 1 }))].slice(0, 50),
    minutes: Math.round(weekMs / 60_000),
  }
  try { await api('me', { method: 'PATCH', body: { taste } }); ls.set(TASTE_AT, Date.now()) } catch { /* next time */ }
}

/** Your taste as the same shape your friends share (so match and Blend compare like with like). */
export function myTaste(): Taste {
  const events = liveEvents()
  const since = Date.now() - 60 * 86_400_000
  return {
    artists: topArtists(events, (id) => trackRegistry.get(id), since).slice(0, 30).map((a) => ({ name: a.name, weight: Math.round(a.ms / 1000), artwork: a.artwork ?? null })),
    tracks: topTracks(events, since).slice(0, 40).map((s) => ({ t: trackRegistry.get(s.id), plays: s.plays })).filter((x) => x.t?.playbackRef).map((x) => ({ track: socialTrack(x.t!), plays: x.plays })),
    minutes: null, at: Date.now(),
  }
}

/** 0–100: how alike two listeners' top artists are (cosine of listening time per artist). */
export function tasteMatch(a: Taste | null, b: Taste | null): number | null {
  if (!a?.artists.length || !b?.artists.length) return null
  const vec = (t: Taste) => { const m = new Map<string, number>(); for (const x of t.artists) m.set(artistKey(x.name), Math.sqrt(Math.max(1, x.weight))); return m }
  const x = vec(a)
  const y = vec(b)
  let dot = 0
  for (const [k, v] of x) dot += v * (y.get(k) ?? 0)
  const norm = (m: Map<string, number>) => Math.sqrt([...m.values()].reduce((s, v) => s + v * v, 0))
  const cos = dot / (norm(x) * norm(y) || 1)
  // Stretch: sharing even a few favourite artists should read as a real match.
  return Math.round(Math.min(1, Math.sqrt(cos) * 1.08) * 100)
}

export function sharedArtists(a: Taste | null, b: Taste | null): { name: string; artwork: string | null }[] {
  if (!a || !b) return []
  const theirs = new Map(b.artists.map((x) => [artistKey(x.name), x]))
  return a.artists.filter((x) => theirs.has(artistKey(x.name))).slice(0, 12).map((x) => ({ name: x.name, artwork: x.artwork ?? theirs.get(artistKey(x.name))?.artwork ?? null }))
}

/** A Blend: both of your favourites, songs you share first, then taking turns. */
export function blend(a: Taste | null, b: Taste | null, limit = 40): Track[] {
  // A Blend needs both of you: a few favourites each.
  if (!a || !b || a.tracks.length < 3 || b.tracks.length < 3) return []
  const mine = a.tracks.map((x) => x.track)
  const theirs = b.tracks.map((x) => x.track)
  const both = new Set(mine.map((t) => t.playbackRef).filter((r) => theirs.some((t) => t.playbackRef === r)))
  const shared = new Set([...a.artists, ...b.artists].map((x) => artistKey(x.name)).filter((k) => a.artists.some((x) => artistKey(x.name) === k) && b.artists.some((x) => artistKey(x.name) === k)))
  const out: SocialTrack[] = [...mine.filter((t) => both.has(t.playbackRef))]
  const rest = (list: SocialTrack[]) => list.filter((t) => !both.has(t.playbackRef)).sort((x, y) => Number(shared.has(artistKey(y.artist))) - Number(shared.has(artistKey(x.artist))))
  const ma = rest(mine)
  const tb = rest(theirs)
  for (let i = 0; out.length < limit && (i < ma.length || i < tb.length); i++) {
    if (tb[i]) out.push(tb[i])
    if (ma[i] && out.length < limit) out.push(ma[i])
  }
  const seen = new Set<string>()
  return out.filter((t) => (seen.has(t.playbackRef) ? false : (seen.add(t.playbackRef), true))).map(asTrack)
}

/** Where a friend's song is right now (for live progress bars). */
export function livePosition(now: NowPlaying): number {
  return now.playing ? now.positionMs + Math.max(0, serverNow() - now.at) : now.positionMs
}

// Library changes (likes) refresh your shared taste a little later.
let tasteTimer: ReturnType<typeof setTimeout> | null = null
useLibrary.subscribe((s, p) => {
  if (s.likes === p.likes) return
  if (tasteTimer) clearTimeout(tasteTimer)
  tasteTimer = setTimeout(() => void uploadTaste(), 60_000)
})
// Debug: window.__arnavSocial() shows the live state.
;(window as unknown as { __arnavSocial: () => unknown }).__arnavSocial = () => ({ ...st(), ws: ws?.readyState ?? null, offset })
