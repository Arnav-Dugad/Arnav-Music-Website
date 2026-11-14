/**
 * Listen together: one Durable Object per room code. Holds who's in the room, who hosts, and the
 * host's "now playing" (song, position, playing), stamped with server time so every guest can line
 * up to the same moment. Relays reactions and song suggestions. WebSocket hibernation keeps idle
 * rooms free; an alarm clears a room 24 h after the last person leaves.
 *
 * Seats: each person gets an id and a secret key when they join; reconnecting with them (a reload,
 * a dropped connection) gives back the same seat — and the host role. A host who drops keeps the
 * room for HOST_GRACE_MS before it passes on. The host can lock the room and remove people.
 */
import { DurableObject } from 'cloudflare:workers'

interface RoomTrack { id: string; title: string; artist: string; album: string | null; playbackRef: string; durationMs: number | null; artworkUrl: string | null; variant?: string | null }
interface PlayState { track: RoomTrack | null; positionMs: number; playing: boolean; rate: number; at: number; upNext: RoomTrack[] }
interface Member { id: string; name: string; joinedAt: number; host: boolean }
interface Attachment { id: string; name: string; joinedAt: number; lastReact: number[]; lastAct?: number[]; replaced?: boolean }
/** A seat you can take back after a reload or a dropped connection (same id, same host role). */
interface Seat { h: string; name: string; joinedAt: number }

const MAX_MEMBERS = 30
const MAX_MESSAGE = 16_000
const IDLE_MS = 24 * 3600_000
/** A host who drops keeps the room this long before it passes to the next person. */
const HOST_GRACE_MS = 30_000
const EMOJI = new Set(['❤️', '🔥', '😍', '🕺', '👏', '😭', '🤯', '🎶'])

const clip = (s: unknown, n: number) => (typeof s === 'string' ? s.slice(0, n) : '')
async function hash(s: string) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(d)].slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join('')
}
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

interface Saved { state: PlayState; hostId: string | null; hostAway?: number | null; locked?: boolean; idleSince?: number | null }

export class ListeningRoom extends DurableObject {
  private state: PlayState = { track: null, positionMs: 0, playing: false, rate: 1, at: 0, upNext: [] }
  private hostId: string | null = null
  /** When the host's connection dropped (they get HOST_GRACE_MS to come back). */
  private hostAway: number | null = null
  /** Locked: only people already in the room (or holding a seat) can join. */
  private locked = false
  private idleSince: number | null = null
  private loading: Promise<void> | null = null

  /** Restores the room after it wakes (once, even when several messages arrive together). */
  private load() {
    this.loading ??= this.ctx.storage.get<Saved>('room').then((saved) => {
      if (saved) { this.state = saved.state; this.hostId = saved.hostId; this.hostAway = saved.hostAway ?? null; this.locked = !!saved.locked; this.idleSince = saved.idleSince ?? null }
    }, () => { this.loading = null })
    return this.loading
  }
  private save() { void this.ctx.storage.put('room', { state: this.state, hostId: this.hostId, hostAway: this.hostAway, locked: this.locked, idleSince: this.idleSince } satisfies Saved) }

  private sockets() { return this.ctx.getWebSockets() }
  private att(ws: WebSocket): Attachment | null { try { return ws.deserializeAttachment() as Attachment } catch { return null } }
  private members(): Member[] {
    return this.sockets().map((ws) => this.att(ws)).filter((a): a is Attachment => !!a && !a.replaced).map((a) => ({ id: a.id, name: a.name, joinedAt: a.joinedAt, host: a.id === this.hostId }))
  }
  private roster(members = this.members()) { return { t: 'members', members, hostId: this.hostId, hostAway: this.hostAway != null, locked: this.locked } }
  private send(ws: WebSocket, msg: unknown) { try { ws.send(JSON.stringify(msg)) } catch { /* closed */ } }
  private broadcast(msg: unknown, except?: WebSocket) { const s = JSON.stringify(msg); for (const ws of this.sockets()) if (ws !== except) { try { ws.send(s) } catch { /* closed */ } } }
  /** Paces chatty actions (rename, suggest): at most [max] in [windowMs] per person. */
  private paced(ws: WebSocket, a: Attachment, max: number, windowMs: number): boolean {
    const now = Date.now()
    const recent = (a.lastAct ?? []).filter((x) => now - x < windowMs)
    if (recent.length >= max) return false
    ws.serializeAttachment({ ...a, lastAct: [...recent, now] })
    return true
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status: 426 })
    await this.load()
    if (this.sockets().length >= MAX_MEMBERS) return new Response('This room is full', { status: 429 })
    const url = new URL(request.url)
    const name = clip(url.searchParams.get('name'), 40).trim() || 'Listener'
    // Coming back to your seat (a reload or a dropped connection): same id, same host role.
    const seatId = clip(url.searchParams.get('seat'), 12)
    const seatKey = clip(url.searchParams.get('key'), 64)
    let seat: Seat | undefined
    if (/^[0-9a-f-]{8}$/.test(seatId) && seatKey) {
      const s = await this.ctx.storage.get<Seat>(`seat:${seatId}`)
      if (s && s.h === await hash(seatKey)) {
        seat = s
        // Its old connection may not have closed yet (a quick reload): retire it quietly.
        for (const old of this.sockets()) {
          const oa = this.att(old)
          if (oa?.id === seatId) { old.serializeAttachment({ ...oa, replaced: true }); try { old.close(4001, 'replaced') } catch { /* closed */ } }
        }
      }
    }
    if (!seat && this.locked && this.sockets().length) return new Response('This room is locked', { status: 423 })
    const pair = new WebSocketPair()
    const [client, server] = [pair[0], pair[1]]
    const id = seat ? seatId : crypto.randomUUID().slice(0, 8)
    const key = seat ? seatKey : crypto.randomUUID().replace(/-/g, '')
    if (!seat) await this.ctx.storage.put(`seat:${id}`, { h: await hash(key), name, joinedAt: Date.now() } satisfies Seat)
    this.ctx.acceptWebSocket(server)
    server.serializeAttachment({ id, name, joinedAt: seat?.joinedAt ?? Date.now(), lastReact: [] } satisfies Attachment)
    this.idleSince = null
    await this.ctx.storage.deleteAlarm()
    if (id === this.hostId) this.hostAway = null
    // A new host only if there's none — and not while the host has a moment to come back.
    else if (!this.hostId || (this.hostAway == null && !this.members().some((m) => m.id === this.hostId))) { this.hostId = id; this.hostAway = null }
    if (this.hostAway != null) await this.ctx.storage.setAlarm(this.hostAway + HOST_GRACE_MS)
    this.save()
    this.send(server, { t: 'welcome', you: id, seatKey: key, hostId: this.hostId, hostAway: this.hostAway != null, locked: this.locked, members: this.members(), state: this.state, serverNow: Date.now() })
    this.broadcast(this.roster(), server)
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
        if (!t || !this.paced(ws, a, 10, 60_000)) return
        for (const s of this.sockets()) if (this.att(s)?.id === this.hostId) this.send(s, { t: 'suggest', from: a.id, name: a.name, track: t })
        return
      }
      case 'makeHost': {
        if (a.id !== this.hostId || typeof m.id !== 'string' || !this.members().some((x) => x.id === m.id)) return
        this.hostId = m.id
        this.hostAway = null
        this.save()
        this.broadcast(this.roster())
        return
      }
      case 'rename': {
        const name = clip(m.name, 40).trim()
        if (!name || !this.paced(ws, a, 5, 60_000)) return
        ws.serializeAttachment({ ...(this.att(ws) ?? a), name })
        this.broadcast(this.roster())
        return
      }
      case 'lock': {
        if (a.id !== this.hostId) return
        this.locked = m.on === true
        this.save()
        this.broadcast(this.roster())
        return
      }
      case 'kick': {
        // The host removes someone; their seat is forgotten so it can't be reclaimed.
        if (a.id !== this.hostId || typeof m.id !== 'string' || m.id === a.id) return
        for (const s of this.sockets()) if (this.att(s)?.id === m.id) { this.send(s, { t: 'kicked' }); try { s.close(4003, 'removed') } catch { /* closed */ } }
        await this.ctx.storage.delete(`seat:${m.id}`)
        this.broadcast(this.roster(this.members().filter((x) => x.id !== m.id)))
        return
      }
    }
  }

  async webSocketClose(ws: WebSocket) { await this.left(ws) }
  async webSocketError(ws: WebSocket) { await this.left(ws) }

  private async left(ws: WebSocket) {
    await this.load()
    try { ws.close() } catch { /* already closed */ }
    // A connection retired because its seat reconnected: the person never left.
    if (this.att(ws)?.replaced) return
    const rest = this.sockets().filter((s) => s !== ws && !this.att(s)?.replaced)
    if (!rest.length) {
      // Last one out: if the music was playing, freeze it where it was.
      if (this.state.playing) this.state = { ...this.state, positionMs: this.state.positionMs + (Date.now() - this.state.at) * this.state.rate, playing: false, at: Date.now() }
      this.hostId = null
      this.hostAway = null
      this.idleSince = Date.now()
      this.save()
      await this.ctx.storage.setAlarm(Date.now() + IDLE_MS)
      return
    }
    const gone = this.att(ws)?.id
    if (gone && gone === this.hostId && this.hostAway == null) {
      // Give the host a moment to come back (a reload, a tunnel) before the room moves on.
      this.hostAway = Date.now()
      this.save()
      await this.ctx.storage.setAlarm(this.hostAway + HOST_GRACE_MS)
    }
    this.broadcast(this.roster(this.members().filter((m) => m.id !== gone)))
  }

  /** The earliest joiner takes over from a host who didn't come back. */
  private handOver() {
    const next = this.sockets().map((s) => this.att(s)).filter((x): x is Attachment => !!x && !x.replaced).sort((x, y) => x.joinedAt - y.joinedAt)[0]
    this.hostId = next?.id ?? null
    this.hostAway = null
    this.save()
    this.broadcast(this.roster())
  }

  async alarm() {
    await this.load()
    if (this.sockets().length) {
      if (this.hostAway != null) {
        if (Date.now() - this.hostAway >= HOST_GRACE_MS - 500) this.handOver()
        else await this.ctx.storage.setAlarm(this.hostAway + HOST_GRACE_MS)
      }
      return
    }
    if (this.idleSince != null && Date.now() - this.idleSince < IDLE_MS - 1000) { await this.ctx.storage.setAlarm(this.idleSince + IDLE_MS); return }
    await this.ctx.storage.deleteAll()
  }
}
