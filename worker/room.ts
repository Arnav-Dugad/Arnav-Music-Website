/**
 * Listen together: one Durable Object per room code. Holds who's in the room, who hosts, and the
 * host's "now playing" (song, position, playing), stamped with server time so every guest can line
 * up to the same moment. Relays reactions and song suggestions. WebSocket hibernation keeps idle
 * rooms free; an alarm clears a room 24 h after the last person leaves.
 */
import { DurableObject } from 'cloudflare:workers'

interface RoomTrack { id: string; title: string; artist: string; album: string | null; playbackRef: string; durationMs: number | null; artworkUrl: string | null; variant?: string | null }
interface PlayState { track: RoomTrack | null; positionMs: number; playing: boolean; rate: number; at: number; upNext: RoomTrack[] }
interface Member { id: string; name: string; joinedAt: number; host: boolean }
interface Attachment { id: string; name: string; joinedAt: number; lastReact: number[] }

const MAX_MEMBERS = 30
const MAX_MESSAGE = 16_000
const IDLE_MS = 24 * 3600_000
const EMOJI = new Set(['❤️', '🔥', '😍', '🕺', '👏', '😭', '🤯', '🎶'])

const clip = (s: unknown, n: number) => (typeof s === 'string' ? s.slice(0, n) : '')
function track(x: unknown): RoomTrack | null {
  if (!x || typeof x !== 'object') return null
  const t = x as Record<string, unknown>
  const ref = clip(t.playbackRef, 20)
  if (!/^[A-Za-z0-9_-]{11}$/.test(ref)) return null
  return {
    id: `yt:${ref}`, title: clip(t.title, 200), artist: clip(t.artist, 200), album: t.album ? clip(t.album, 200) : null, playbackRef: ref,
    durationMs: typeof t.durationMs === 'number' && t.durationMs > 0 && t.durationMs < 4 * 3600_000 ? Math.round(t.durationMs) : null,
    artworkUrl: typeof t.artworkUrl === 'string' && /^https:\/\/(i\d?\.ytimg\.com|is\d-ssl\.mzstatic\.com|yt3\.ggpht\.com|lh3\.googleusercontent\.com)\//.test(t.artworkUrl) ? t.artworkUrl.slice(0, 300) : null,
    variant: t.variant === 'SONG' || t.variant === 'VIDEO' ? t.variant : null,
  }
}

export class ListeningRoom extends DurableObject {
  private state: PlayState = { track: null, positionMs: 0, playing: false, rate: 1, at: 0, upNext: [] }
  private hostId: string | null = null
  private loaded = false

  private async load() {
    if (this.loaded) return
    this.loaded = true
    const saved = await this.ctx.storage.get<{ state: PlayState; hostId: string | null }>('room')
    if (saved) { this.state = saved.state; this.hostId = saved.hostId }
  }
  private save() { void this.ctx.storage.put('room', { state: this.state, hostId: this.hostId }) }

  private sockets() { return this.ctx.getWebSockets() }
  private att(ws: WebSocket): Attachment | null { try { return ws.deserializeAttachment() as Attachment } catch { return null } }
  private members(): Member[] {
    return this.sockets().map((ws) => this.att(ws)).filter((a): a is Attachment => !!a).map((a) => ({ id: a.id, name: a.name, joinedAt: a.joinedAt, host: a.id === this.hostId }))
  }
  private send(ws: WebSocket, msg: unknown) { try { ws.send(JSON.stringify(msg)) } catch { /* closed */ } }
  private broadcast(msg: unknown, except?: WebSocket) { const s = JSON.stringify(msg); for (const ws of this.sockets()) if (ws !== except) { try { ws.send(s) } catch { /* closed */ } } }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status: 426 })
    await this.load()
    if (this.sockets().length >= MAX_MEMBERS) return new Response('This room is full', { status: 429 })
    const url = new URL(request.url)
    const name = clip(url.searchParams.get('name'), 40).trim() || 'Listener'
    const pair = new WebSocketPair()
    const [client, server] = [pair[0], pair[1]]
    const id = crypto.randomUUID().slice(0, 8)
    this.ctx.acceptWebSocket(server)
    server.serializeAttachment({ id, name, joinedAt: Date.now(), lastReact: [] } satisfies Attachment)
    await this.ctx.storage.deleteAlarm()
    if (!this.hostId || !this.members().some((m) => m.id === this.hostId && m.id !== id)) this.hostId = id
    this.save()
    this.send(server, { t: 'welcome', you: id, hostId: this.hostId, members: this.members(), state: this.state, serverNow: Date.now() })
    this.broadcast({ t: 'members', members: this.members(), hostId: this.hostId }, server)
    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    await this.load()
    if (typeof raw !== 'string' || raw.length > MAX_MESSAGE) return
    const a = this.att(ws)
    if (!a) return
    let m: Record<string, unknown>
    try { m = JSON.parse(raw) } catch { return }
    const now = Date.now()
    switch (m.t) {
      case 'ping':
        this.send(ws, { t: 'pong', c: typeof m.c === 'number' ? m.c : 0, serverNow: now })
        return
      case 'state': {
        if (a.id !== this.hostId) return
        const t = m.track === null ? null : track(m.track)
        const pos = typeof m.positionMs === 'number' && Number.isFinite(m.positionMs) ? Math.max(0, Math.round(m.positionMs)) : 0
        const upNext = Array.isArray(m.upNext) ? (m.upNext as unknown[]).slice(0, 5).map(track).filter((x): x is RoomTrack => !!x) : []
        this.state = { track: t, positionMs: pos, playing: m.playing === true, rate: typeof m.rate === 'number' && m.rate >= 0.5 && m.rate <= 2 ? m.rate : 1, at: now, upNext }
        this.save()
        this.broadcast({ t: 'state', state: this.state, serverNow: now }, ws)
        return
      }
      case 'react': {
        const emoji = clip(m.emoji, 8)
        if (!EMOJI.has(emoji)) return
        // At most 6 reactions in 3 seconds per person.
        const recent = a.lastReact.filter((x) => now - x < 3000)
        if (recent.length >= 6) return
        ws.serializeAttachment({ ...a, lastReact: [...recent, now] })
        this.broadcast({ t: 'react', from: a.id, name: a.name, emoji, at: now })
        return
      }
      case 'suggest': {
        const t = track(m.track)
        if (!t) return
        for (const s of this.sockets()) if (this.att(s)?.id === this.hostId) this.send(s, { t: 'suggest', from: a.id, name: a.name, track: t })
        return
      }
      case 'makeHost': {
        if (a.id !== this.hostId || typeof m.id !== 'string' || !this.members().some((x) => x.id === m.id)) return
        this.hostId = m.id
        this.save()
        this.broadcast({ t: 'members', members: this.members(), hostId: this.hostId })
        return
      }
      case 'rename': {
        const name = clip(m.name, 40).trim()
        if (!name) return
        ws.serializeAttachment({ ...a, name })
        this.broadcast({ t: 'members', members: this.members(), hostId: this.hostId })
        return
      }
    }
  }

  async webSocketClose(ws: WebSocket) { await this.left(ws) }
  async webSocketError(ws: WebSocket) { await this.left(ws) }

  private async left(ws: WebSocket) {
    await this.load()
    try { ws.close() } catch { /* already closed */ }
    const rest = this.sockets().filter((s) => s !== ws)
    if (!rest.length) {
      // Last one out: if the music was playing, freeze it where it was.
      if (this.state.playing) this.state = { ...this.state, positionMs: this.state.positionMs + (Date.now() - this.state.at) * this.state.rate, playing: false, at: Date.now() }
      this.hostId = null
      this.save()
      await this.ctx.storage.setAlarm(Date.now() + IDLE_MS)
      return
    }
    const gone = this.att(ws)?.id
    if (gone === this.hostId) {
      this.hostId = null
      const next = rest.map((s) => this.att(s)).filter((x): x is Attachment => !!x).sort((x, y) => x.joinedAt - y.joinedAt)[0]
      this.hostId = next?.id ?? null
      this.save()
    }
    const members = this.members().filter((m) => m.id !== gone)
    this.broadcast({ t: 'members', members, hostId: this.hostId })
  }

  async alarm() {
    if (this.sockets().length) return
    await this.ctx.storage.deleteAll()
  }
}
