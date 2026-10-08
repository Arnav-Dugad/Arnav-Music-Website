import { generate, noteFallback, type AiUnavailable } from '../lib/ai'
import { buildSession, interpretLocally, parseSession, sessionPrompt, SESSION_VERSION, type BuiltSession, type SessionConstraints } from '../lib/intent'
import { cachedSearch, search, ytQuotaState } from '../lib/youtube'
import { isSingle } from '../lib/classify'
import { artistKey, type Track } from '../lib/types'
import { allows, likedIds, liveEvents } from '../state/library'
import { trackRegistry } from '../state/tracks'
import { settings } from '../state/settings'
import { profile } from './recs'
import { ls } from '../lib/idb'

export type Step = 'interpret' | 'search' | 'order' | 'done'

export interface SessionResult {
  session: BuiltSession
  usedAi: boolean
  model: string | null
  unavailable: AiUnavailable | null
  searched: number
  request: string
}

function listenerContext() {
  if (!settings().aiPersonalization) return { artists: [] as string[], genres: [] as string[] }
  const p = profile()
  const names = new Map<string, string>()
  for (const t of trackRegistry.all()) names.set(artistKey(t.artist), t.artist)
  const artists = [...p.artistAffinity.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k]) => names.get(k) ?? k)
  const genres = [...p.genreAffinity.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([g]) => g)
  return { artists, genres }
}

/** “45 minutes of energetic coding music…” → constraints → real songs → ordered session. */
export async function createSession(request: string, onStep: (s: Step) => void, base?: SessionConstraints): Promise<SessionResult> {
  onStep('interpret')
  const ctx = listenerContext()
  let constraints: SessionConstraints | null = base ?? null
  let usedAi = false
  let model: string | null = null
  let unavailable: AiUnavailable | null = null
  if (!constraints) {
    const r = await generate(sessionPrompt(request, ctx.artists, ctx.genres, new Date().getHours()), SESSION_VERSION, { json: true })
    if (r.ok) {
      constraints = parseSession(r.text)
      if (constraints) { usedAi = true; model = r.model }
      else unavailable = 'MALFORMED'
    } else unavailable = r.reason
    if (!constraints) {
      noteFallback()
      constraints = interpretLocally(request, ctx.artists)
    }
  }
  remember(request)

  onStep('search')
  const queries = [...new Set([...constraints.searchQueries, ...constraints.seedArtists.map((a) => `${a} songs`)].map((q) => q.trim()).filter(Boolean))].slice(0, 6)
  const state = ytQuotaState()
  const budget = state === 'NORMAL' ? 4 : state === 'CONSERVE' ? 2 : 0
  const pool: Track[] = []
  let remote = 0
  let searched = 0
  await Promise.all(queries.map(async (q, i) => {
    const c = await cachedSearch(q, 'SONGS')
    if (c) { pool.push(...c.tracks); searched++; return }
    if (i >= budget || remote >= budget) return
    remote++
    try { pool.push(...(await search(q, 'SONGS')).tracks); searched++ } catch { /* other queries still count */ }
  }))

  // Familiar candidates from your own listening, filtered so they fit the request.
  const p = profile()
  const seeds = new Set(constraints.seedArtists.map(artistKey))
  const target = constraints.energyTarget
  const familiar = trackRegistry.many([...p.trackPlayCounts.keys(), ...likedIds()]).filter((t) =>
    seeds.has(artistKey(t.artist)) || (t.energy != null && Math.abs(t.energy - target) < 0.2) || (constraints!.rediscover && (Date.now() - (p.lastPlayedAt.get(t.id) ?? 0)) > 30 * 86_400_000))
  const want = constraints.familiarity
  const candidates = [...pool, ...(want >= 0.4 || constraints.rediscover ? familiar : familiar.slice(0, 10))]
    .filter((t) => isSingle(t) && allows(t))

  onStep('order')
  const session = buildSession(constraints, candidates, p, likedIds())
  onStep('done')
  return { session, usedAi, model, unavailable, searched, request }
}

export function recentPrompts(): string[] { return ls.get<string[]>('arnav.aiPrompts', []) }
function remember(q: string) {
  const v = q.trim()
  if (!v) return
  ls.set('arnav.aiPrompts', [v, ...recentPrompts().filter((x) => x !== v)].slice(0, 10))
}

export function hasHistory() { return liveEvents().length > 0 }

/** Quick refinements that adjust the constraints without another AI call. */
export function refine(c: SessionConstraints, kind: 'calmer' | 'energetic' | 'newer' | 'familiar' | 'shorter' | 'longer'): SessionConstraints {
  const n = { ...c }
  if (kind === 'calmer') n.energyTarget = Math.max(0.05, c.energyTarget - 0.18)
  if (kind === 'energetic') n.energyTarget = Math.min(0.98, c.energyTarget + 0.18)
  if (kind === 'newer') { n.discoveryRatio = Math.min(0.9, c.discoveryRatio + 0.3); n.familiarity = Math.max(0.1, c.familiarity - 0.3) }
  if (kind === 'familiar') { n.discoveryRatio = Math.max(0.05, c.discoveryRatio - 0.25); n.familiarity = Math.min(0.95, c.familiarity + 0.25) }
  if (kind === 'shorter') n.durationMinutes = Math.max(10, Math.round(c.durationMinutes * 0.6))
  if (kind === 'longer') n.durationMinutes = Math.min(240, Math.round(c.durationMinutes * 1.6))
  return n
}
