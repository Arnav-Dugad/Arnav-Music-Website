/**
 * Social hub: profiles, friends, live "listening now" presence, listen-along, an inbox for song
 * shares and room invites, friends' activity and charts. One SQLite-backed Durable Object.
 *
 * Identity: every profile has an id and a secret device key (sent as `x-social: <id>.<key>`), so
 * people can be social without signing in. Signing in with Firebase links the profile to the
 * account (`/link`), and another device signing in to the same account gets the same profile.
 * Presence travels over one WebSocket per open app (hibernation keeps idle sockets free).
 */
import { DurableObject } from 'cloudflare:workers'
import { verifyFirebaseToken } from './firebaseToken'

interface Env { FIREBASE_PROJECT_ID?: string }

type Privacy = 'everyone' | 'friends' | 'off'
interface UserRow { id: string; uid: string | null; handle: string; name: string; avatar: string | null; color: string; bio: string | null; code: string; privacy: Privacy; taste: string | null; created: number; seen: number }
interface SocialTrack { id: string; title: string; artist: string; album: string | null; playbackRef: string; durationMs: number | null; artworkUrl: string | null; variant?: string | null }
interface NowPlaying { track: SocialTrack | null; positionMs: number; playing: boolean; at: number; room: string | null }
interface Attachment { id: string | null; follow: string | null; hits: number[] }

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const COLORS = ['#ff5f6d', '#ffa62b', '#ffd23f', '#3ddc97', '#2ec4b6', '#4cc9f0', '#4361ee', '#7b2ff7', '#f72585', '#b5179e']
const RESERVED = new Set(['admin', 'arnav', 'arnavmusic', 'support', 'help', 'settings', 'friends', 'together', 'official', 'system', 'null', 'undefined', 'me', 'you'])
const HANDLE = /^[a-z0-9](?:[a-z0-9._]{1,18}[a-z0-9])?$/
const NOW_FRESH_MS = 12 * 60_000
const DAY = 86_400_000
const EMOJI = new Set(['❤️', '🔥', '😍', '😂', '🕺', '😭', '🤯', '🎶'])

const clip = (s: unknown, n: number) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n) : '')
const rand = (n: number) => [...crypto.getRandomValues(new Uint8Array(n))].map((x) => ALPHABET[x % ALPHABET.length]).join('')
async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const ART = /^https:\/\/(i\d?\.ytimg\.com|is\d-ssl\.mzstatic\.com|yt3\.ggpht\.com|lh3\.googleusercontent\.com)\//

function track(x: unknown): SocialTrack | null {
  if (!x || typeof x !== 'object') return null
  const t = x as Record<string, unknown>
  const ref = clip(t.playbackRef, 20)
  if (!/^[A-Za-z0-9_-]{11}$/.test(ref)) return null
  return {
    id: `yt:${ref}`, title: clip(t.title, 200) || 'Untitled', artist: clip(t.artist, 200), album: t.album ? clip(t.album, 200) : null, playbackRef: ref,
    durationMs: typeof t.durationMs === 'number' && t.durationMs > 0 && t.durationMs < 4 * 3600_000 ? Math.round(t.durationMs) : null,
    artworkUrl: typeof t.artworkUrl === 'string' && ART.test(t.artworkUrl) ? t.artworkUrl.slice(0, 300) : null,
    variant: t.variant === 'SONG' || t.variant === 'VIDEO' ? t.variant : null,
  }
}
const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/\p{M}+/gu, '').replace(/[^a-z0-9]+/g, '').slice(0, 14)

export class SocialHub extends DurableObject<Env> {
  private sql: SqlStorage
  /** Per-user action stamps for rate limits (reset when the hub sleeps — fine for abuse limits). */
  private limits = new Map<string, number[]>()
  /** Set once the daily clean-up alarm is known to be scheduled (per wake). */
  private alarmChecked = false

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.sql = ctx.storage.sql
    this.sql.exec(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, uid TEXT UNIQUE, handle TEXT UNIQUE NOT NULL, name TEXT NOT NULL, avatar TEXT, color TEXT NOT NULL, bio TEXT, code TEXT UNIQUE NOT NULL, privacy TEXT NOT NULL DEFAULT 'friends', taste TEXT, created INTEGER NOT NULL, seen INTEGER NOT NULL)`)
    this.sql.exec(`CREATE TABLE IF NOT EXISTS keys (hash TEXT PRIMARY KEY, id TEXT NOT NULL, at INTEGER NOT NULL)`)
    this.sql.exec(`CREATE TABLE IF NOT EXISTS links (a TEXT NOT NULL, b TEXT NOT NULL, state TEXT NOT NULL, by TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (a, b))`)
    this.sql.exec(`CREATE INDEX IF NOT EXISTS links_b ON links (b)`)
    this.sql.exec(`CREATE TABLE IF NOT EXISTS inbox (n INTEGER PRIMARY KEY AUTOINCREMENT, to_id TEXT NOT NULL, from_id TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL, at INTEGER NOT NULL, read INTEGER NOT NULL DEFAULT 0, reaction TEXT)`)
    this.sql.exec(`CREATE INDEX IF NOT EXISTS inbox_to ON inbox (to_id, n)`)
    this.sql.exec(`CREATE TABLE IF NOT EXISTS plays (user TEXT NOT NULL, at INTEGER NOT NULL, track TEXT NOT NULL)`)
    this.sql.exec(`CREATE INDEX IF NOT EXISTS plays_user ON plays (user, at)`)
    this.sql.exec(`CREATE TABLE IF NOT EXISTS now (user TEXT PRIMARY KEY, body TEXT NOT NULL, at INTEGER NOT NULL)`)
    // One-time WebSocket tickets: the device key never travels in a URL. Stored (not in memory) so a
    // ticket still works if the hub sleeps between handing it out and the socket connecting.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS tickets (t TEXT PRIMARY KEY, id TEXT NOT NULL, until INTEGER NOT NULL)`)
    // Public playlists: a snapshot of one of your playlists that anyone with the link can open.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS pubs (id TEXT PRIMARY KEY, owner TEXT NOT NULL, src TEXT NOT NULL, title TEXT NOT NULL, description TEXT, tracks TEXT NOT NULL, count INTEGER NOT NULL, art TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL, saves INTEGER NOT NULL DEFAULT 0, UNIQUE (owner, src))`)
    this.sql.exec(`CREATE INDEX IF NOT EXISTS pubs_owner ON pubs (owner, updated)`)
    // Keep-alive pings are answered without waking the hub (no duration billed, no cold start).
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'))
  }

  /** Daily clean-up: old plays, stale presence, used tickets, and device keys beyond the newest 10. */
  async alarm() {
    const now = Date.now()
    this.sql.exec('DELETE FROM plays WHERE at < ?', now - 30 * DAY)
    this.sql.exec('DELETE FROM now WHERE at < ?', now - 2 * DAY)
    this.sql.exec('DELETE FROM tickets WHERE until < ?', now)
    this.sql.exec('DELETE FROM keys WHERE rowid IN (SELECT rowid FROM (SELECT rowid, ROW_NUMBER() OVER (PARTITION BY id ORDER BY at DESC) AS r FROM keys) WHERE r > 10)')
    await this.ctx.storage.setAlarm(now + DAY)
  }
  private async ensureAlarm() {
    if (this.alarmChecked) return
    this.alarmChecked = true
    if ((await this.ctx.storage.getAlarm()) == null) await this.ctx.storage.setAlarm(Date.now() + DAY)
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  private user(id: string): UserRow | null { return (this.sql.exec('SELECT * FROM users WHERE id = ?', id).toArray()[0] as unknown as UserRow) ?? null }
  private pair(x: string, y: string) { return x < y ? [x, y] : [y, x] }
  private link(x: string, y: string): { state: string; by: string; at: number } | null {
    const [a, b] = this.pair(x, y)
    return (this.sql.exec('SELECT state, by, at FROM links WHERE a = ? AND b = ?', a, b).toArray()[0] as { state: string; by: string; at: number }) ?? null
  }
  private friendIds(id: string): string[] {
    return this.sql.exec(`SELECT CASE WHEN a = ? THEN b ELSE a END AS f FROM links WHERE (a = ? OR b = ?) AND state = 'friends'`, id, id, id).toArray().map((r) => String(r.f))
  }
  private areFriends(x: string, y: string) { return this.link(x, y)?.state === 'friends' }
  private limited(id: string, kind: string, max: number, windowMs: number): boolean {
    const k = `${id}:${kind}`
    const now = Date.now()
    const hits = (this.limits.get(k) ?? []).filter((t) => now - t < windowMs)
    if (hits.length >= max) return true
    hits.push(now)
    this.limits.set(k, hits)
    return false
  }
  private publicView(u: UserRow) { return { id: u.id, handle: u.handle, name: u.name, avatar: u.avatar, color: u.color, bio: u.bio } }
  private nowOf(id: string): NowPlaying | null {
    const r = this.sql.exec('SELECT body, at FROM now WHERE user = ?', id).toArray()[0]
    if (!r || Date.now() - Number(r.at) > NOW_FRESH_MS) return null
    return JSON.parse(String(r.body)) as NowPlaying
  }
  /** What a viewer may see of someone: their profile, and their activity if privacy allows. */
  private viewFor(viewer: string | null, u: UserRow) {
    const rel = viewer ? this.link(viewer, u.id) : null
    const friend = rel?.state === 'friends'
    const showActivity = viewer === u.id || (u.privacy === 'everyone' && rel?.state !== 'blocked') || (u.privacy === 'friends' && friend)
    return {
      ...this.publicView(u),
      relation: viewer === u.id ? 'me' : !rel ? 'none' : rel.state === 'friends' ? 'friends' : rel.state === 'blocked' ? (rel.by === viewer ? 'blocked' : 'none') : rel.by === viewer ? 'requested' : 'incoming',
      online: showActivity ? this.online(u.id) : false,
      now: showActivity ? this.nowOf(u.id) : null,
      taste: showActivity && u.taste ? JSON.parse(u.taste) : null,
      listeners: showActivity ? this.listenersOf(u.id).length : 0,
      seen: showActivity ? u.seen : null,
    }
  }
  private online(id: string) { return this.ctx.getWebSockets(id).length > 0 }
  private att(ws: WebSocket): Attachment { try { return (ws.deserializeAttachment() as Attachment) ?? { id: null, follow: null, hits: [] } } catch { return { id: null, follow: null, hits: [] } } }
  private push(id: string, msg: unknown) { const s = JSON.stringify(msg); for (const ws of this.ctx.getWebSockets(id)) { try { ws.send(s) } catch { /* closed */ } } }
  private listenersOf(id: string): string[] {
    return [...new Set(this.ctx.getWebSockets().map((ws) => this.att(ws)).filter((a) => a.follow === id && a.id).map((a) => a.id as string))]
  }
  private tellListeners(id: string) {
    const ids = this.listenersOf(id)
    const people = ids.map((x) => this.user(x)).filter((u): u is UserRow => !!u).map((u) => this.publicView(u))
    this.push(id, { t: 'listeners', people })
  }
  private async auth(request: Request): Promise<UserRow | null> {
    const h = request.headers.get('x-social') ?? ''
    const dot = h.indexOf('.')
    if (dot < 1) return null
    const id = h.slice(0, dot)
    const hash = await sha256(h.slice(dot + 1))
    const row = this.sql.exec('SELECT id FROM keys WHERE hash = ?', hash).toArray()[0]
    if (!row || row.id !== id) return null
    const u = this.user(id)
    if (u && Date.now() - u.seen > 60_000) this.sql.exec('UPDATE users SET seen = ? WHERE id = ?', Date.now(), id)
    return u
  }
  private uniqueHandle(base: string): string {
    let h = slug(base) || 'listener'
    if (h.length < 3) h = `${h}music`
    if (RESERVED.has(h)) h = `${h}1`
    const taken = (x: string) => this.sql.exec('SELECT 1 FROM users WHERE handle = ?', x).toArray().length > 0
    if (!taken(h)) return h
    for (let i = 0; i < 50; i++) { const c = `${h.slice(0, 15)}${Math.floor(100 + Math.random() * 9900)}`; if (!taken(c)) return c }
    return `${h.slice(0, 10)}${rand(6).toLowerCase()}`
  }
  private async newKey(id: string): Promise<string> {
    const key = rand(32)
    this.sql.exec('INSERT INTO keys (hash, id, at) VALUES (?, ?, ?)', await sha256(key), id, Date.now())
    // Each device sign-in adds a key: keep the newest 10 per profile.
    this.sql.exec('DELETE FROM keys WHERE id = ? AND hash NOT IN (SELECT hash FROM keys WHERE id = ? ORDER BY at DESC LIMIT 10)', id, id)
    return key
  }
  private me(u: UserRow) {
    const rows = this.sql.exec(`SELECT * FROM links WHERE a = ? OR b = ?`, u.id, u.id).toArray() as unknown as { a: string; b: string; state: string; by: string; at: number }[]
    const people = (pred: (r: (typeof rows)[number]) => boolean) => rows.filter(pred).map((r) => this.user(r.a === u.id ? r.b : r.a)).filter((x): x is UserRow => !!x)
    const friends = people((r) => r.state === 'friends').map((f) => this.viewFor(u.id, f))
    const incoming = people((r) => r.state === 'pending' && r.by !== u.id).map((f) => this.publicView(f))
    const outgoing = people((r) => r.state === 'pending' && r.by === u.id).map((f) => this.publicView(f))
    const unread = Number(this.sql.exec('SELECT COUNT(*) AS c FROM inbox WHERE to_id = ? AND read = 0', u.id).one().c)
    return { profile: { ...this.publicView(u), code: u.code, privacy: u.privacy, linked: !!u.uid }, friends, incoming, outgoing, unread }
  }
  private inboxItem(r: Record<string, unknown>) {
    const from = this.user(String(r.from_id))
    return { n: Number(r.n), kind: String(r.kind), from: from ? this.publicView(from) : null, body: JSON.parse(String(r.body)), at: Number(r.at), read: !!r.read, reaction: (r.reaction as string) ?? null, mine: false }
  }

  // ── HTTP ──────────────────────────────────────────────────────────────────
  async fetch(request: Request): Promise<Response> {
    try {
      void this.ensureAlarm().catch(() => undefined)
      return await this.route(request)
    } catch (e) {
      console.error('[social]', e instanceof Error ? e.stack ?? e.message : e)
      return json({ error: 'failed', message: 'Something went wrong on our side. Try again in a moment.' }, 500)
    }
  }

  private async route(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname.replace(/^\/api\/social\/?/, '')
    if (path === 'ws') {
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status: 426 })
      const t = url.searchParams.get('ticket') ?? ''
      const ticket = this.sql.exec('SELECT id, until FROM tickets WHERE t = ?', t).toArray()[0] as { id: string; until: number } | undefined
      this.sql.exec('DELETE FROM tickets WHERE t = ?', t)
      if (!ticket || ticket.until < Date.now() || !this.user(ticket.id)) return new Response('Unauthorized', { status: 401 })
      const id = ticket.id
      const pair = new WebSocketPair()
      const server = pair[1]
      // Tagged with the user id, so pushes reach every app this person has open.
      this.ctx.acceptWebSocket(server, [id])
      server.serializeAttachment({ id, follow: null, hits: [] } satisfies Attachment)
      const now = Date.now()
      this.sql.exec('UPDATE users SET seen = ? WHERE id = ?', now, id)
      server.send(JSON.stringify({ t: 'hello', serverNow: now }))
      const friends = this.friendIds(id).map((f) => this.user(f)).filter((f): f is UserRow => !!f)
      server.send(JSON.stringify({ t: 'snapshot', presence: friends.map((f) => ({ id: f.id, online: f.privacy !== 'off' && this.online(f.id), now: f.privacy !== 'off' ? this.nowOf(f.id) : null })) }))
      if (this.ctx.getWebSockets(id).length <= 1) this.broadcastPresence(id, this.nowOf(id))
      return new Response(null, { status: 101, webSocket: pair[0] })
    }
    let body: Record<string, unknown> = {}
    if (request.method === 'POST' || request.method === 'PATCH') {
      const text = await request.text()
      if (text.length > 40_000) return json({ error: 'too_large' }, 413)
      try { body = text ? JSON.parse(text) : {} } catch { return json({ error: 'bad_json' }, 400) }
    }
    if (path === 'register' && request.method === 'POST') return this.register(body, request)
    // A public playlist opens for anyone with the link: no profile needed.
    if (request.method === 'GET' && path.startsWith('pl/')) return this.publicPlaylist(decodeURIComponent(path.slice(3)))
    const me = await this.auth(request)
    if (!me) return json({ error: 'unauthorized' }, 401)
    const seg = path.split('/')
    try {
      switch (`${request.method} ${seg[0]}`) {
        case 'GET me': return json(this.me(me))
        case 'POST ticket': {
          if (this.limited(me.id, 'ticket', 30, 600_000)) return json({ error: 'slow_down' }, 429)
          const ticket = rand(24)
          this.sql.exec('DELETE FROM tickets WHERE until < ?', Date.now())
          this.sql.exec('INSERT INTO tickets (t, id, until) VALUES (?, ?, ?)', ticket, me.id, Date.now() + 60_000)
          return json({ ticket })
        }
        case 'PATCH me': return this.update(me, body)
        case 'POST link': return this.linkAccount(me, body)
        case 'GET find': return this.find(me, url)
        case 'GET u': return this.profile(me, decodeURIComponent(seg[1] ?? ''))
        case 'POST friend': return this.befriend(me, body)
        case 'POST respond': return this.respond(me, body)
        case 'POST unfriend': return this.unfriend(me, body)
        case 'POST block': return this.block(me, body)
        case 'POST send': return this.send(me, body)
        case 'GET inbox': return this.inbox(me)
        case 'POST read': this.sql.exec('UPDATE inbox SET read = 1 WHERE to_id = ?', me.id); return json({ ok: true })
        case 'POST react': return this.reactTo(me, body)
        case 'GET feed': return this.feed(me)
        case 'GET charts': return this.charts(me)
        case 'POST delete': return this.deleteProfile(me)
        case 'POST publish': return this.publish(me, body)
        case 'POST unpublish': return this.unpublish(me, body)
        case 'GET pubs': return json({ items: this.pubsOf(me.id) })
        case 'POST saved': {
          const id = clip(body.id, 16)
          if (id && !this.limited(me.id, `save:${id}`, 1, DAY)) this.sql.exec('UPDATE pubs SET saves = saves + 1 WHERE id = ? AND owner != ?', id, me.id)
          return json({ ok: true })
        }
      }
    } catch (e) {
      return json({ error: 'failed', message: e instanceof Error ? e.message.slice(0, 160) : 'unknown' }, 500)
    }
    return json({ error: 'not_found' }, 404)
  }

  private async register(body: Record<string, unknown>, request: Request): Promise<Response> {
    const ip = request.headers.get('cf-connecting-ip') ?? 'x'
    if (this.limited(ip, 'register', 8, 3600_000)) return json({ error: 'slow_down' }, 429)
    const name = clip(body.name, 40) || 'Listener'
    const id = crypto.randomUUID().replace(/-/g, '').slice(0, 16)
    const handle = this.uniqueHandle(clip(body.handle, 20) || name)
    let code = rand(8)
    while (this.sql.exec('SELECT 1 FROM users WHERE code = ?', code).toArray().length) code = rand(8)
    const now = Date.now()
    this.sql.exec('INSERT INTO users (id, handle, name, avatar, color, bio, code, privacy, created, seen) VALUES (?, ?, ?, NULL, ?, NULL, ?, ?, ?, ?)',
      id, handle, name, COLORS[Math.floor(Math.random() * COLORS.length)], code, 'friends', now, now)
    const key = await this.newKey(id)
    const u = this.user(id) as UserRow
    // Signed in already: link right away (and pick up the account's existing profile, if any).
    if (typeof body.idToken === 'string') {
      const linked = await this.linkAccount(u, { idToken: body.idToken }, key)
      return linked
    }
    return json({ id, key, ...this.me(u) })
  }

  private async linkAccount(u: UserRow, body: Record<string, unknown>, keyForNew?: string): Promise<Response> {
    const ident = typeof body.idToken === 'string' ? await verifyFirebaseToken(body.idToken, this.env.FIREBASE_PROJECT_ID || 'arnav-music-c8ca5') : null
    if (!ident) return json({ error: 'bad_token' }, 401)
    const owner = this.sql.exec('SELECT id FROM users WHERE uid = ?', ident.uid).toArray()[0]
    if (owner && owner.id !== u.id) {
      // This account already has a profile: this device joins it (a brand-new, empty profile is dropped).
      const other = this.user(String(owner.id)) as UserRow
      const empty = !this.sql.exec('SELECT 1 FROM links WHERE a = ? OR b = ?', u.id, u.id).toArray().length && Date.now() - u.created < 10 * 60_000
      if (empty) { this.sql.exec('DELETE FROM users WHERE id = ?', u.id); this.sql.exec('DELETE FROM keys WHERE id = ?', u.id) }
      const key = await this.newKey(other.id)
      return json({ id: other.id, key, switched: true, ...this.me(other) })
    }
    this.sql.exec('UPDATE users SET uid = ?, avatar = COALESCE(avatar, ?), name = CASE WHEN name = ? THEN ? ELSE name END WHERE id = ?',
      ident.uid, ident.picture && ART.test(ident.picture) ? ident.picture : null, 'Listener', ident.name ?? 'Listener', u.id)
    const fresh = this.user(u.id) as UserRow
    return json({ id: fresh.id, ...(keyForNew ? { key: keyForNew } : {}), ...this.me(fresh) })
  }

  private update(u: UserRow, body: Record<string, unknown>): Response {
    if (body.handle !== undefined) {
      const h = clip(body.handle, 20).toLowerCase().replace(/^@/, '')
      if (!HANDLE.test(h) || RESERVED.has(h)) return json({ error: 'bad_handle', message: 'Use 3–20 letters, numbers, dots or underscores.' }, 400)
      if (h !== u.handle && this.sql.exec('SELECT 1 FROM users WHERE handle = ?', h).toArray().length) return json({ error: 'handle_taken', message: `@${h} is taken.` }, 409)
      this.sql.exec('UPDATE users SET handle = ? WHERE id = ?', h, u.id)
    }
    if (body.name !== undefined) { const n = clip(body.name, 40); if (n) this.sql.exec('UPDATE users SET name = ? WHERE id = ?', n, u.id) }
    if (body.bio !== undefined) this.sql.exec('UPDATE users SET bio = ? WHERE id = ?', clip(body.bio, 160) || null, u.id)
    if (body.color !== undefined && COLORS.includes(String(body.color))) this.sql.exec('UPDATE users SET color = ? WHERE id = ?', String(body.color), u.id)
    if (body.avatar !== undefined) this.sql.exec('UPDATE users SET avatar = ? WHERE id = ?', typeof body.avatar === 'string' && ART.test(body.avatar) ? body.avatar.slice(0, 400) : null, u.id)
    if (body.privacy === 'everyone' || body.privacy === 'friends' || body.privacy === 'off') {
      this.sql.exec('UPDATE users SET privacy = ? WHERE id = ?', body.privacy, u.id)
      // A private session hides you straight away.
      if (body.privacy === 'off') this.broadcastPresence(u.id, null)
    }
    if (body.taste !== undefined) {
      const t = body.taste as { artists?: unknown; tracks?: unknown; minutes?: unknown } | null
      const artists = Array.isArray(t?.artists) ? (t.artists as unknown[]).slice(0, 40).map((a) => { const x = a as Record<string, unknown>; return { name: clip(x.name, 80), weight: typeof x.weight === 'number' ? Math.max(0, Math.min(1e7, x.weight)) : 0, artwork: typeof x.artwork === 'string' && ART.test(x.artwork) ? x.artwork.slice(0, 300) : null } }).filter((a) => a.name) : []
      const tracks = Array.isArray(t?.tracks) ? (t.tracks as unknown[]).slice(0, 50).map((x) => ({ track: track((x as Record<string, unknown>).track), plays: Number((x as Record<string, unknown>).plays) || 1 })).filter((x) => x.track) : []
      const minutes = typeof t?.minutes === 'number' ? Math.max(0, Math.min(100_000, Math.round(t.minutes))) : null
      this.sql.exec('UPDATE users SET taste = ? WHERE id = ?', JSON.stringify({ artists, tracks, minutes, at: Date.now() }), u.id)
    }
    return json(this.me(this.user(u.id) as UserRow))
  }

  private find(u: UserRow, url: URL): Response {
    const code = clip(url.searchParams.get('code'), 12).toUpperCase()
    if (code) {
      const r = this.sql.exec('SELECT * FROM users WHERE code = ?', code).toArray()[0] as unknown as UserRow | undefined
      return json({ people: r ? [this.viewFor(u.id, r)] : [] })
    }
    const q = clip(url.searchParams.get('q'), 30).toLowerCase().replace(/^@/, '')
    if (q.length < 2) return json({ people: [] })
    const like = `${q.replace(/[%_]/g, '')}%`
    const rows = this.sql.exec(`SELECT * FROM users WHERE id != ? AND (handle LIKE ? OR lower(name) LIKE ? OR lower(name) LIKE ?) ORDER BY seen DESC LIMIT 12`, u.id, like, like, `% ${like}`).toArray() as unknown as UserRow[]
    return json({ people: rows.filter((r) => this.link(u.id, r.id)?.state !== 'blocked').map((r) => this.viewFor(u.id, r)) })
  }

  private profile(u: UserRow, key: string): Response {
    const r = (this.sql.exec('SELECT * FROM users WHERE id = ? OR handle = ?', key, key.toLowerCase().replace(/^@/, '')).toArray()[0] as unknown as UserRow) ?? null
    if (!r) return json({ error: 'not_found' }, 404)
    const view = this.viewFor(u.id, r)
    const recent = view.now !== null || view.relation === 'me' || r.privacy === 'everyone' || view.relation === 'friends'
      ? this.sql.exec('SELECT at, track FROM plays WHERE user = ? ORDER BY at DESC LIMIT 30', r.id).toArray().map((x) => ({ at: Number(x.at), track: JSON.parse(String(x.track)) as SocialTrack }))
      : []
    const mutual = view.relation === 'me' ? 0 : this.friendIds(u.id).filter((f) => this.areFriends(f, r.id)).length
    // Playlists they made public show to everyone, whatever their activity privacy.
    const blocked = this.link(u.id, r.id)?.state === 'blocked'
    return json({ person: view, recent: (r.privacy === 'off' && view.relation !== 'me') ? [] : recent, mutual, playlists: blocked ? [] : this.pubsOf(r.id) })
  }

  private target(body: Record<string, unknown>): UserRow | null {
    const id = clip(body.id, 40)
    if (id) return this.user(id)
    const handle = clip(body.handle, 21).toLowerCase().replace(/^@/, '')
    if (handle) return (this.sql.exec('SELECT * FROM users WHERE handle = ?', handle).toArray()[0] as unknown as UserRow) ?? null
    const code = clip(body.code, 12).toUpperCase()
    if (code) return (this.sql.exec('SELECT * FROM users WHERE code = ?', code).toArray()[0] as unknown as UserRow) ?? null
    return null
  }

  private befriend(u: UserRow, body: Record<string, unknown>): Response {
    const t = this.target(body)
    if (!t) return json({ error: 'not_found', message: 'No one has that name here yet.' }, 404)
    if (t.id === u.id) return json({ error: 'self', message: 'That’s you!' }, 400)
    const rel = this.link(u.id, t.id)
    if (rel?.state === 'blocked') return json({ error: 'blocked', message: 'You can’t add this person.' }, 403)
    if (rel?.state === 'friends') return json({ ok: true, state: 'friends' })
    const [a, b] = this.pair(u.id, t.id)
    // They asked you first, or you opened their invite link: you're friends now.
    if ((rel?.state === 'pending' && rel.by === t.id) || body.code) {
      this.sql.exec(`INSERT INTO links (a, b, state, by, at) VALUES (?, ?, 'friends', ?, ?) ON CONFLICT (a, b) DO UPDATE SET state = 'friends', at = excluded.at`, a, b, u.id, Date.now())
      this.push(t.id, { t: 'friends', who: this.publicView(u) })
      this.push(t.id, { t: 'refresh' })
      return json({ ok: true, state: 'friends', person: this.viewFor(u.id, t) })
    }
    if (rel?.state === 'pending') return json({ ok: true, state: 'requested' })
    if (this.limited(u.id, 'friend', 40, 3600_000)) return json({ error: 'slow_down', message: 'That’s a lot of requests — try again in a bit.' }, 429)
    this.sql.exec(`INSERT INTO links (a, b, state, by, at) VALUES (?, ?, 'pending', ?, ?)`, a, b, u.id, Date.now())
    this.push(t.id, { t: 'request', who: this.publicView(u) })
    return json({ ok: true, state: 'requested' })
  }

  private respond(u: UserRow, body: Record<string, unknown>): Response {
    const t = this.target(body)
    const rel = t ? this.link(u.id, t.id) : null
    if (!t || rel?.state !== 'pending' || rel.by === u.id) return json({ error: 'no_request' }, 404)
    const [a, b] = this.pair(u.id, t.id)
    if (body.accept === true) {
      this.sql.exec(`UPDATE links SET state = 'friends', at = ? WHERE a = ? AND b = ?`, Date.now(), a, b)
      this.push(t.id, { t: 'friends', who: this.publicView(u) })
      this.push(t.id, { t: 'refresh' })
    } else this.sql.exec('DELETE FROM links WHERE a = ? AND b = ?', a, b)
    return json(this.me(u))
  }

  private unfriend(u: UserRow, body: Record<string, unknown>): Response {
    const t = this.target(body)
    if (!t) return json({ error: 'not_found' }, 404)
    const [a, b] = this.pair(u.id, t.id)
    const rel = this.link(u.id, t.id)
    if (rel && !(rel.state === 'blocked' && rel.by !== u.id)) this.sql.exec('DELETE FROM links WHERE a = ? AND b = ?', a, b)
    this.push(t.id, { t: 'refresh' })
    return json(this.me(u))
  }

  private block(u: UserRow, body: Record<string, unknown>): Response {
    const t = this.target(body)
    if (!t || t.id === u.id) return json({ error: 'not_found' }, 404)
    const [a, b] = this.pair(u.id, t.id)
    this.sql.exec(`INSERT INTO links (a, b, state, by, at) VALUES (?, ?, 'blocked', ?, ?) ON CONFLICT (a, b) DO UPDATE SET state = 'blocked', by = excluded.by, at = excluded.at`, a, b, u.id, Date.now())
    this.sql.exec('DELETE FROM inbox WHERE to_id = ? AND from_id = ?', u.id, t.id)
    this.push(t.id, { t: 'refresh' })
    return json(this.me(u))
  }

  private send(u: UserRow, body: Record<string, unknown>): Response {
    const ids = (Array.isArray(body.to) ? body.to : [body.to]).map((x) => clip(x, 40)).filter(Boolean).slice(0, 20)
    const kind = body.kind === 'invite' ? 'invite' : body.kind === 'share' ? 'share' : null
    if (!kind || !ids.length) return json({ error: 'bad_request' }, 400)
    if (this.limited(u.id, 'send', 120, 3600_000)) return json({ error: 'slow_down', message: 'You’ve sent a lot — try again in a bit.' }, 429)
    let payload: Record<string, unknown>
    if (kind === 'share') {
      const t = track(body.track)
      if (!t) return json({ error: 'bad_track' }, 400)
      payload = { track: t, note: clip(body.note, 280) || null }
    } else {
      const room = clip(body.room, 6).toUpperCase()
      if (!/^[A-Z2-9]{6}$/.test(room)) return json({ error: 'bad_room' }, 400)
      payload = { room, track: track(body.track), note: clip(body.note, 140) || null }
    }
    const sent: string[] = []
    for (const id of ids) {
      if (!this.areFriends(u.id, id)) continue
      const at = Date.now()
      this.sql.exec('INSERT INTO inbox (to_id, from_id, kind, body, at) VALUES (?, ?, ?, ?, ?)', id, u.id, kind, JSON.stringify(payload), at)
      const n = Number(this.sql.exec('SELECT last_insert_rowid() AS n').one().n)
      this.push(id, { t: 'inbox', item: { n, kind, from: this.publicView(u), body: payload, at, read: false, reaction: null } })
      // Keep each inbox to its newest 300.
      this.sql.exec('DELETE FROM inbox WHERE to_id = ? AND n NOT IN (SELECT n FROM inbox WHERE to_id = ? ORDER BY n DESC LIMIT 300)', id, id)
      sent.push(id)
    }
    return json({ ok: true, sent: sent.length })
  }

  private inbox(u: UserRow): Response {
    const got = this.sql.exec('SELECT * FROM inbox WHERE to_id = ? ORDER BY n DESC LIMIT 100', u.id).toArray().map((r) => this.inboxItem(r))
    const sent = this.sql.exec('SELECT * FROM inbox WHERE from_id = ? ORDER BY n DESC LIMIT 40', u.id).toArray().map((r) => {
      const to = this.user(String(r.to_id))
      return { ...this.inboxItem(r), from: null, to: to ? this.publicView(to) : null, mine: true }
    })
    return json({ items: got, sent })
  }

  private reactTo(u: UserRow, body: Record<string, unknown>): Response {
    const n = Number(body.n)
    const emoji = clip(body.emoji, 8)
    if (!Number.isInteger(n) || (emoji && !EMOJI.has(emoji))) return json({ error: 'bad_request' }, 400)
    const r = this.sql.exec('SELECT * FROM inbox WHERE n = ? AND to_id = ?', n, u.id).toArray()[0]
    if (!r) return json({ error: 'not_found' }, 404)
    this.sql.exec('UPDATE inbox SET reaction = ?, read = 1 WHERE n = ?', emoji || null, n)
    if (emoji) this.push(String(r.from_id), { t: 'reaction', n, emoji, who: this.publicView(u), body: JSON.parse(String(r.body)) })
    return json({ ok: true })
  }

  /** Deletes your profile and everything tied to it (friends, inbox, plays, presence). */
  private deleteProfile(u: UserRow): Response {
    const friends = this.friendIds(u.id)
    for (const t of ['DELETE FROM users WHERE id = ?', 'DELETE FROM keys WHERE id = ?', 'DELETE FROM plays WHERE user = ?', 'DELETE FROM now WHERE user = ?']) this.sql.exec(t, u.id)
    this.sql.exec('DELETE FROM links WHERE a = ? OR b = ?', u.id, u.id)
    this.sql.exec('DELETE FROM inbox WHERE to_id = ? OR from_id = ?', u.id, u.id)
    this.sql.exec('DELETE FROM pubs WHERE owner = ?', u.id)
    for (const f of friends) this.push(f, { t: 'refresh' })
    for (const ws of this.ctx.getWebSockets(u.id)) { try { ws.close(1000, 'deleted') } catch { /* closed */ } }
    return json({ ok: true })
  }

  private feed(u: UserRow): Response {
    const friends = this.friendIds(u.id).map((id) => this.user(id)).filter((f): f is UserRow => !!f && f.privacy !== 'off')
    const since = Date.now() - 3 * DAY
    const items: { who: ReturnType<SocialHub['publicView']>; at: number; track: SocialTrack }[] = []
    for (const f of friends) {
      for (const r of this.sql.exec('SELECT at, track FROM plays WHERE user = ? AND at > ? ORDER BY at DESC LIMIT 25', f.id, since).toArray()) {
        items.push({ who: this.publicView(f), at: Number(r.at), track: JSON.parse(String(r.track)) })
      }
    }
    items.sort((a, b) => b.at - a.at)
    return json({ items: items.slice(0, 80) })
  }

  private charts(u: UserRow): Response {
    const people = [u, ...this.friendIds(u.id).map((id) => this.user(id)).filter((f): f is UserRow => !!f && f.privacy !== 'off')]
    const since = Date.now() - 7 * DAY
    const m = new Map<string, { track: SocialTrack; plays: number; who: Set<string> }>()
    for (const p of people) {
      for (const r of this.sql.exec('SELECT track FROM plays WHERE user = ? AND at > ?', p.id, since).toArray()) {
        const t = JSON.parse(String(r.track)) as SocialTrack
        const e = m.get(t.playbackRef) ?? { track: t, plays: 0, who: new Set<string>() }
        e.plays++
        e.who.add(p.id)
        m.set(t.playbackRef, e)
      }
    }
    const byId = new Map(people.map((p) => [p.id, this.publicView(p)]))
    const top = [...m.values()].sort((a, b) => b.who.size - a.who.size || b.plays - a.plays).slice(0, 30)
      .map((e) => ({ track: e.track, plays: e.plays, listeners: [...e.who].map((id) => byId.get(id)).filter(Boolean) }))
    return json({ items: top, people: people.length })
  }

  // ── Public playlists ──────────────────────────────────────────────────────
  private pubsOf(owner: string) {
    return this.sql.exec('SELECT id, src, title, count, art, updated, saves FROM pubs WHERE owner = ? ORDER BY updated DESC LIMIT 60', owner).toArray()
      .map((r) => ({ id: String(r.id), src: String(r.src), title: String(r.title), count: Number(r.count), art: (r.art as string) ?? null, updated: Number(r.updated), saves: Number(r.saves) }))
  }

  /** Publishes (or updates) a snapshot of one of your playlists. `src` is the playlist's id in your library. */
  private publish(u: UserRow, body: Record<string, unknown>): Response {
    const src = clip(body.src, 80)
    const title = clip(body.title, 100)
    if (!src || !title) return json({ error: 'bad_request' }, 400)
    if (this.limited(u.id, 'publish', 120, 3600_000)) return json({ error: 'slow_down', message: 'That’s a lot of updates — try again in a bit.' }, 429)
    const tracks = (Array.isArray(body.tracks) ? body.tracks : []).slice(0, 500).map(track).filter((t): t is SocialTrack => !!t)
    if (!tracks.length) return json({ error: 'empty', message: 'Add a few songs before making it public.' }, 400)
    const description = clip(body.description, 300) || null
    const art = typeof body.art === 'string' && ART.test(body.art) ? body.art.slice(0, 300) : tracks[0].artworkUrl
    const now = Date.now()
    const existing = this.sql.exec('SELECT id FROM pubs WHERE owner = ? AND src = ?', u.id, src).toArray()[0]
    if (existing) {
      this.sql.exec('UPDATE pubs SET title = ?, description = ?, tracks = ?, count = ?, art = ?, updated = ? WHERE id = ?', title, description, JSON.stringify(tracks), tracks.length, art, now, String(existing.id))
      return json({ id: String(existing.id), updated: now })
    }
    const mine = Number(this.sql.exec('SELECT COUNT(*) AS c FROM pubs WHERE owner = ?', u.id).one().c)
    if (mine >= 50) return json({ error: 'too_many', message: 'You can have up to 50 public playlists.' }, 400)
    let id = rand(10)
    while (this.sql.exec('SELECT 1 FROM pubs WHERE id = ?', id).toArray().length) id = rand(10)
    this.sql.exec('INSERT INTO pubs (id, owner, src, title, description, tracks, count, art, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', id, u.id, src, title, description, JSON.stringify(tracks), tracks.length, art, now, now)
    return json({ id, updated: now })
  }

  private unpublish(u: UserRow, body: Record<string, unknown>): Response {
    const id = clip(body.id, 16)
    const src = clip(body.src, 80)
    if (id) this.sql.exec('DELETE FROM pubs WHERE id = ? AND owner = ?', id, u.id)
    else if (src) this.sql.exec('DELETE FROM pubs WHERE src = ? AND owner = ?', src, u.id)
    return json({ ok: true, items: this.pubsOf(u.id) })
  }

  private publicPlaylist(id: string): Response {
    if (!/^[A-Z2-9]{10}$/.test(id)) return json({ error: 'not_found' }, 404)
    const r = this.sql.exec('SELECT * FROM pubs WHERE id = ?', id).toArray()[0]
    const owner = r ? this.user(String(r.owner)) : null
    if (!r || !owner) return json({ error: 'not_found', message: 'This playlist isn’t public any more.' }, 404)
    return json({
      playlist: { id, title: String(r.title), description: (r.description as string) ?? null, tracks: JSON.parse(String(r.tracks)) as SocialTrack[], count: Number(r.count), art: (r.art as string) ?? null, created: Number(r.created), updated: Number(r.updated), saves: Number(r.saves) },
      owner: this.publicView(owner),
    })
  }

  // ── Presence (WebSocket) ──────────────────────────────────────────────────
  private broadcastPresence(id: string, now: NowPlaying | null) {
    const u = this.user(id)
    if (!u) return
    const visible = u.privacy !== 'off'
    const msg = { t: 'presence', id, online: visible && this.online(id), now: visible ? now : null }
    for (const f of this.friendIds(id)) this.push(f, msg)
    // Listening along without being friends isn't possible, so only friends' sockets get this.
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    if (typeof raw !== 'string' || raw.length > 12_000) return
    let m: Record<string, unknown>
    try { m = JSON.parse(raw) } catch { return }
    const a = this.att(ws)
    const now = Date.now()
    if (m.t === 'ping') { ws.send(JSON.stringify({ t: 'pong', c: typeof m.c === 'number' ? m.c : 0, serverNow: now })); return }
    if (!a.id) return
    const hits = a.hits.filter((t) => now - t < 10_000)
    if (hits.length > 30) return
    ws.serializeAttachment({ ...a, hits: [...hits, now] })
    switch (m.t) {
      case 'np': {
        const t = m.track === null ? null : track(m.track)
        const np: NowPlaying = {
          track: t, playing: m.playing === true && !!t,
          positionMs: typeof m.positionMs === 'number' && Number.isFinite(m.positionMs) ? Math.max(0, Math.round(m.positionMs)) : 0,
          at: now, room: typeof m.room === 'string' && /^[A-Z2-9]{6}$/.test(m.room) ? m.room : null,
        }
        const prev = this.nowOf(a.id)
        this.sql.exec('INSERT INTO now (user, body, at) VALUES (?, ?, ?) ON CONFLICT (user) DO UPDATE SET body = excluded.body, at = excluded.at', a.id, JSON.stringify(np), now)
        // A new song started: it joins your recent plays (friends' feed and charts).
        if (t && np.playing && prev?.track?.playbackRef !== t.playbackRef) {
          const last = this.sql.exec('SELECT track, at FROM plays WHERE user = ? ORDER BY at DESC LIMIT 1', a.id).toArray()[0]
          if (!last || JSON.parse(String(last.track)).playbackRef !== t.playbackRef || now - Number(last.at) > 20 * 60_000) {
            this.sql.exec('INSERT INTO plays (user, at, track) VALUES (?, ?, ?)', a.id, now, JSON.stringify(t))
            this.sql.exec('DELETE FROM plays WHERE user = ? AND at < ?', a.id, now - 30 * DAY)
          }
        }
        const u = this.user(a.id)
        if (u?.privacy !== 'off') this.broadcastPresence(a.id, np)
        return
      }
      case 'follow': {
        const target = clip(m.id, 40) || null
        if (target && (!this.areFriends(a.id, target) || this.user(target)?.privacy === 'off')) { ws.send(JSON.stringify({ t: 'follow', ok: false, id: target })); return }
        const before = a.follow
        ws.serializeAttachment({ ...a, follow: target, hits: [...hits, now] })
        if (before && before !== target) this.tellListeners(before)
        if (target) {
          this.tellListeners(target)
          ws.send(JSON.stringify({ t: 'follow', ok: true, id: target, now: this.nowOf(target), serverNow: now }))
        }
        return
      }
      case 'wave': {
        // A quick hello / "come listen" nudge between friends.
        const target = clip(m.id, 40)
        const emoji = EMOJI.has(clip(m.emoji, 8)) ? clip(m.emoji, 8) : '👋'
        const u = this.user(a.id)
        if (u && this.areFriends(a.id, target) && !this.limited(a.id, 'wave', 20, 60_000)) this.push(target, { t: 'wave', who: this.publicView(u), emoji })
        return
      }
    }
  }

  async webSocketClose(ws: WebSocket) { this.gone(ws) }
  async webSocketError(ws: WebSocket) { this.gone(ws) }
  private gone(ws: WebSocket) {
    const a = this.att(ws)
    try { ws.close() } catch { /* closed */ }
    if (!a.id) return
    if (a.follow) { ws.serializeAttachment({ ...a, follow: null }); this.tellListeners(a.follow) }
    const still = this.ctx.getWebSockets(a.id).filter((s) => s !== ws).length
    if (!still) {
      const u = this.user(a.id)
      if (u && u.privacy !== 'off') for (const f of this.friendIds(a.id)) this.push(f, { t: 'presence', id: a.id, online: false, now: this.nowOf(a.id) })
    }
  }
}
