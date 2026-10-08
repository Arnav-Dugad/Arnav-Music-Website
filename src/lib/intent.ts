import { MOODS, artistKey, type AestheticDescriptor, type Mood, type Track, type TrackId } from './types'
import { rank, type Reason, type TasteProfile, type Scored } from './taste'

export type EnergyCurve = 'FLAT' | 'RISING' | 'FALLING' | 'WAVE' | 'PEAK'

/** Structured interpretation of a request — by Gemini when available, else on device. */
export interface SessionConstraints {
  title: string
  durationMinutes: number
  energyTarget: number
  energyCurve: EnergyCurve
  familiarity: number
  discoveryRatio: number
  artistDiversity: number
  moods: string[]
  avoidMoods: string[]
  context: string | null
  seedArtists: string[]
  searchQueries: string[]
  rediscover: boolean
  aesthetic: AestheticDescriptor
  explanation?: string | null
}

const clamp = (v: unknown, lo: number, hi: number, d: number) => {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : d
  return Math.min(hi, Math.max(lo, n))
}
const strs = (v: unknown, n: number, len: number) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').slice(0, n).map((x) => x.slice(0, len)) : [])

export function sanitize(c: Partial<SessionConstraints>): SessionConstraints {
  const curve = String(c.energyCurve ?? 'FLAT').trim().toUpperCase()
  const a = (c.aesthetic ?? {}) as Partial<AestheticDescriptor>
  return {
    title: (typeof c.title === 'string' ? c.title : '').slice(0, 60).trim() || 'Your session',
    durationMinutes: Math.round(clamp(c.durationMinutes, 5, 240, 45)),
    energyTarget: clamp(c.energyTarget, 0, 1, 0.55),
    energyCurve: (['FLAT', 'RISING', 'FALLING', 'WAVE', 'PEAK'].includes(curve) ? curve : 'FLAT') as EnergyCurve,
    familiarity: clamp(c.familiarity, 0, 1, 0.6),
    discoveryRatio: clamp(c.discoveryRatio, 0, 1, 0.3),
    artistDiversity: clamp(c.artistDiversity, 0, 1, 0.7),
    moods: strs(c.moods, 6, 24).map((m) => m.toLowerCase()),
    avoidMoods: strs(c.avoidMoods, 6, 24).map((m) => m.toLowerCase()),
    context: typeof c.context === 'string' && c.context.trim() ? c.context.slice(0, 40) : null,
    seedArtists: strs(c.seedArtists, 5, 60),
    searchQueries: strs(c.searchQueries, 4, 80).filter((q) => !/\b(mix|playlist|mashup|jukebox|compilation|nonstop|hour)\b/i.test(q)),
    rediscover: Boolean(c.rediscover),
    aesthetic: {
      mood: typeof a.mood === 'string' ? a.mood.slice(0, 24) : 'neutral',
      energy: clamp(a.energy, 0, 1, 0.5),
      warmth: clamp(a.warmth, 0, 1, 0.5),
      motion: clamp(a.motion, 0, 1, 0.4),
      density: clamp(a.density, 0, 1, 0.4),
      paletteHints: strs(a.paletteHints, 4, 24),
    },
    explanation: typeof c.explanation === 'string' ? c.explanation.slice(0, 160) : null,
  }
}

export const moodSet = (c: SessionConstraints): Mood[] =>
  c.moods.map((m) => (Object.keys(MOODS) as Mood[]).find((k) => k.toLowerCase() === m || MOODS[k].label.toLowerCase() === m)).filter((m): m is Mood => !!m)

// ── Prompt (versioned; same contract as the Android app's PromptLibrary.sessionPrompt) ──
export const SESSION_VERSION = 'session-v4'
export function sessionPrompt(request: string, topArtists: string[], topGenres: string[], hour: number): string {
  return `You are Arnav AI, the music intelligence inside the Arnav Music app.
Convert the listener's request into listening-session constraints. Do NOT invent song titles.
seedArtists: 3-5 real, well-known artists whose individual songs fit the request and the listener's taste
(mix in the listener's artists when it fits; match their language/region when obvious).
searchQueries: 2-4 short phrases that find SINGLE songs on YouTube, e.g. "<artist> songs" or "<genre> <mood> song".
Never use the words mix, playlist, mashup, jukebox, compilation, nonstop or hour.
Listener context (opt-in, approximate): top artists=${topArtists.slice(0, 8).join(', ')}; top genres=${topGenres.slice(0, 5).join(', ')}; local hour=${hour}.
Request: "${request.slice(0, 300).replace(/"/g, "'")}"
Respond ONLY with JSON matching:
{"title":string<=40 chars,"durationMinutes":int 5-240,"energyTarget":0..1,"energyCurve":"FLAT|RISING|FALLING|WAVE|PEAK",
 "familiarity":0..1,"discoveryRatio":0..1,"artistDiversity":0..1,"moods":[string],"avoidMoods":[string],
 "context":string|null,"seedArtists":[string],"searchQueries":[2-4 short search phrases],"rediscover":bool,
 "aesthetic":{"mood":string,"energy":0..1,"warmth":0..1,"motion":0..1,"density":0..1,"paletteHints":[string]},
 "explanation":string<=120 chars}`
}

/** Tolerant parser: handles ```json fences, leading prose, trailing junk, unknown keys. */
export function extractObject(raw: string): string | null {
  const start = raw.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i]
    if (inString) {
      if (escape) escape = false
      else if (ch === '\\') escape = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}') { depth--; if (depth === 0) return raw.slice(start, i + 1) }
  }
  return null
}

export function parseSession(raw: string): SessionConstraints | null {
  const obj = extractObject(raw)
  if (!obj) return null
  try {
    const c = sanitize(JSON.parse(obj) as Partial<SessionConstraints>)
    if (!c.searchQueries.length && !c.seedArtists.length && !c.moods.length) return null
    return c
  } catch {
    return null
  }
}

// ── LocalIntentEngine: the guaranteed offline Arnav AI ───────────────────────
const moodLexicon: [Mood, string[]][] = [
  ['ENERGETIC', ['energetic', 'energy', 'hype', 'pumped', 'powerful', 'intense', 'fast']],
  ['UPBEAT', ['upbeat', 'happy', 'cheerful', 'bright', 'feel good', 'feel-good', 'fun', 'sunny', 'positive']],
  ['CALM', ['calm', 'relax', 'relaxing', 'peaceful', 'soothing', 'gentle', 'soft', 'sleep', 'unwind', 'calmer']],
  ['FOCUS', ['focus', 'coding', 'code', 'study', 'studying', 'work', 'concentrate', 'deep work', 'reading', 'programming']],
  ['NIGHT', ['night', 'late-night', 'late night', 'midnight', '2am', 'nocturnal', 'after dark']],
  ['MELANCHOLY', ['sad', 'melancholy', 'melancholic', 'heartbreak', 'blue', 'rainy', 'moody', 'lonely']],
  ['ROMANTIC', ['romantic', 'love', 'date', 'romance']],
  ['PARTY', ['party', 'dance', 'club', 'banger', 'bangers']],
  ['WORKOUT', ['gym', 'workout', 'run', 'running', 'lifting', 'training', 'cardio']],
  ['CINEMATIC', ['cinematic', 'epic', 'movie', 'soundtrack', 'score', 'drive', 'driving']],
  ['ACOUSTIC', ['acoustic', 'unplugged', 'guitar', 'folk']],
  ['CHILL', ['chill', 'lofi', 'lo-fi', 'laid back', 'laid-back', 'mellow', 'easy', 'vibe']],
  ['AGGRESSIVE', ['aggressive', 'angry', 'heavy', 'metal', 'hard', 'rage']],
  ['NOSTALGIC', ['nostalgic', 'throwback', 'old', 'classic', 'classics', 'retro', '90s', '80s', '2000s']],
]
const contextLexicon: [string, string[]][] = [
  ['coding', ['coding', 'programming', 'code']],
  ['study', ['study', 'studying', 'exam', 'exams', 'homework']],
  ['gym', ['gym', 'workout', 'lifting', 'training']],
  ['run', ['run', 'running', 'jog']],
  ['drive', ['drive', 'driving', 'road trip', 'roadtrip']],
  ['sleep', ['sleep', 'bedtime', 'falling asleep']],
  ['party', ['party', 'pregame']],
  ['cooking', ['cooking', 'kitchen']],
  ['commute', ['commute', 'train', 'bus']],
]
const negators = ['not', 'no', 'without', 'avoid', 'never', 'less', 'nothing', 'but not']
const durationRegex = /(\d{1,3}(?:\.\d)?)\s*(h|hr|hrs|hour|hours|m|min|mins|minute|minutes)\b/
const wordDuration: [string, number][] = [
  ['half an hour', 30], ['half hour', 30], ['an hour', 60], ['one hour', 60], ['two hours', 120],
  ['quarter of an hour', 15], ['hour and a half', 90], ['couple of hours', 120],
]
const similarRegex = /(?:like|similar to|songs by|music by|by|from)\s+([\p{L}\p{N}][\p{L}\p{N} .&'-]{1,40})/giu

function parseDuration(text: string): number {
  const m = durationRegex.exec(text)
  if (!m) {
    const w = [...wordDuration].sort((a, b) => b[0].length - a[0].length).find(([k]) => text.includes(k))
    return w ? w[1] : 45
  }
  const value = Number(m[1])
  if (!Number.isFinite(value)) return 45
  const minutes = m[2].startsWith('h') ? value * 60 : value
  return Math.min(240, Math.max(5, Math.floor(minutes)))
}

export function interpretLocally(input: string, recentArtists: string[] = []): SessionConstraints {
  const text = ` ${input.toLowerCase().replace(/[!?,;:]/g, ' ').replace(/\s+/g, ' ').trim()} `
  const wanted = new Set<Mood>()
  const avoided = new Set<Mood>()
  for (const [mood, words] of moodLexicon) {
    for (const w of words) {
      const idx = text.indexOf(` ${w} `)
      if (idx < 0) continue
      const window = text.slice(Math.max(0, idx - 18), idx)
      const negated = negators.some((n) => window.includes(` ${n} `) || window.endsWith(` ${n}`))
      if (negated) avoided.add(mood)
      else wanted.add(mood)
    }
  }
  avoided.forEach((m) => wanted.delete(m))
  const context = contextLexicon.find(([, ws]) => ws.some((w) => text.includes(` ${w} `)))?.[0] ?? null
  if (context === 'coding' || context === 'study') wanted.add('FOCUS')
  if (context === 'gym' || context === 'run') wanted.add('WORKOUT')
  if (context === 'sleep') wanted.add('CALM')
  if (context === 'drive') wanted.add('CINEMATIC')
  const minutes = parseDuration(text)
  const calmer = [' calmer ', ' slower ', ' softer '].some((w) => text.includes(w))
  const harder = [' harder ', ' faster ', ' more energetic '].some((w) => text.includes(w))
  const wl = [...wanted]
  let energy = wl.length ? wl.reduce((a, m) => a + MOODS[m].energy, 0) / wl.length : 0.55
  if (calmer) energy -= 0.2
  if (harder) energy += 0.15
  if (avoided.has('AGGRESSIVE')) energy = Math.min(energy, 0.8)
  const has = (l: string[]) => l.some((w) => text.includes(w))
  const curve: EnergyCurve =
    has(['gradually increase', 'build up', 'builds up', 'ramp up', 'increase in energy', 'warm up', 'rising']) ? 'RISING'
      : has(['wind down', 'cool down', 'calm down', 'decrease', 'fade out', 'winding down']) ? 'FALLING'
        : has(['peak', 'climax']) ? 'PEAK'
          : has(['waves', 'ups and downs', 'mix it up']) ? 'WAVE' : 'FLAT'
  const rediscover = has(['rediscover', "haven't played", 'havent played', 'forgotten', 'old favorites', 'old favourites', "haven't heard"])
  const wantsNew = ['new', 'discover', 'surprise', 'surprises', 'fresh', 'never heard', 'something different'].some((w) => text.includes(` ${w} `))
  const mostlyFamiliar = ['familiar', 'favorites', 'favourites', 'know', 'comfort'].some((w) => text.includes(` ${w}`))
  const familiarity = rediscover ? 0.9 : wantsNew && mostlyFamiliar ? 0.7 : wantsNew ? 0.25 : mostlyFamiliar ? 0.85 : 0.6
  const discovery = rediscover ? 0.05 : wantsNew && mostlyFamiliar ? 0.2 : wantsNew ? 0.7 : mostlyFamiliar ? 0.1 : 0.3
  let seeds = [...input.matchAll(similarRegex)].map((m) => m[1].trim().replace(/\.+$/, ''))
    .filter((s) => s.length >= 2 && !['this', 'that', 'me', 'something', 'music', 'songs'].includes(s.toLowerCase()))
  if (!seeds.length && (text.includes(' related ') || text.includes(' similar '))) seeds = recentArtists.slice(0, 2)
  const queries: string[] = [...seeds]
  const moodWords = wl.slice(0, 2).map((m) => MOODS[m].label.toLowerCase()).join(' ')
  const ctx = context ? ` ${context}` : ''
  // "songs" (not "music"): generic "… music" queries mostly return mixes and compilations.
  if (moodWords || ctx) queries.push(`${moodWords}${ctx} songs`.trim())
  if (!queries.length) queries.push('popular songs')
  const primary = wl[0]
  const cap = (s: string) => s[0].toUpperCase() + s.slice(1)
  let title = rediscover ? 'Rediscovery'
    : primary && context ? `${MOODS[primary].label} ${cap(context)}`
      : context ? `${cap(context)} session`
        : primary ? `${MOODS[primary].label} mix` : 'Your session'
  if (curve === 'RISING' && !rediscover) title += ' · building'
  return sanitize({
    title, durationMinutes: minutes, energyTarget: Math.min(0.98, Math.max(0.05, energy)), energyCurve: curve,
    familiarity, discoveryRatio: discovery, artistDiversity: seeds.length ? 0.45 : 0.75,
    moods: wl.map((m) => m.toLowerCase()), avoidMoods: [...avoided].map((m) => m.toLowerCase()), context,
    seedArtists: seeds, searchQueries: queries, rediscover,
    aesthetic: {
      mood: context ?? primary?.toLowerCase() ?? 'open', energy: Math.min(1, Math.max(0, energy)),
      warmth: primary ? MOODS[primary].valence : 0.5, motion: Math.min(0.9, Math.max(0.1, energy * 0.8)),
      density: wanted.has('FOCUS') || wanted.has('CALM') ? 0.2 : 0.5, paletteHints: [],
    },
  })
}

// ── SessionBuilder ───────────────────────────────────────────────────────────
export function energyAt(c: SessionConstraints, position: number): number {
  const p = Math.min(1, Math.max(0, position))
  const b = c.energyTarget
  const e = c.energyCurve === 'RISING' ? b - 0.25 + 0.5 * p
    : c.energyCurve === 'FALLING' ? b + 0.25 - 0.5 * p
      : c.energyCurve === 'PEAK' ? b - 0.2 + 0.4 * Math.sin(Math.PI * p)
        : c.energyCurve === 'WAVE' ? b + 0.15 * Math.sin(2 * Math.PI * 2 * p) : b
  return Math.min(1, Math.max(0, e))
}

export interface BuiltSession {
  constraints: SessionConstraints
  tracks: Track[]
  reasons: Record<TrackId, Reason>
  totalMs: number
  discovered: number
}

/** Turns constraints + real, resolved candidates into an ordered queue. Deterministic. */
export function buildSession(c: SessionConstraints, candidates: Track[], profile: TasteProfile, liked: Set<TrackId>, now = Date.now(), tune?: NonNullable<Parameters<typeof rank>[2]>['tune']): BuiltSession {
  const targetMs = c.durationMinutes * 60_000
  const ranked = rank(candidates, profile, { now, liked, targetEnergy: c.energyTarget, discovery: c.discoveryRatio, tune })
  if (!ranked.length) return { constraints: c, tracks: [], reasons: {}, totalMs: 0, discovered: 0 }
  const fam = (s: Scored) => profile.trackFamiliarity.get(s.track.id) ?? 0
  const familiarPool = ranked.filter((s) => fam(s) >= 0.15)
  const newPool = ranked.filter((s) => fam(s) < 0.15)
  const maxPerArtist = c.artistDiversity >= 0.8 ? 2 : c.artistDiversity >= 0.5 ? 3 : 5
  const per = new Map<string, number>()
  const out: Scored[] = []
  let total = 0
  let discovered = 0
  let guard = 0
  while (total < targetMs && (familiarPool.length || newPool.length) && guard++ < 500) {
    const wantNew = (out.length === 0 && c.familiarity < 0.4) || (out.length > 0 && discovered / (out.length + 1) < c.discoveryRatio)
    const pool = wantNew && newPool.length ? newPool : familiarPool.length ? familiarPool : newPool
    const desired = energyAt(c, total / targetMs)
    const lastArtist = out.length ? artistKey(out[out.length - 1].track.artist) : null
    let best: Scored | null = null
    let bestScore = -Infinity
    for (const s of pool.slice(0, 40)) {
      const k = artistKey(s.track.artist)
      if (k === lastArtist || (per.get(k) ?? 0) >= maxPerArtist) continue
      const fit = s.track.energy != null ? 1 - Math.abs(s.track.energy - desired) : 0.6
      const v = s.score + 0.8 * fit
      if (v > bestScore) { bestScore = v; best = s }
    }
    if (!best) { pool.shift(); continue }
    pool.splice(pool.indexOf(best), 1)
    out.push(best)
    const k = artistKey(best.track.artist)
    per.set(k, (per.get(k) ?? 0) + 1)
    if (fam(best) < 0.15) discovered++
    const d = best.track.durationMs
    total += d && d >= 30_000 && d <= 1_200_000 ? d : 210_000
  }
  return {
    constraints: c,
    tracks: out.map((s) => s.track),
    reasons: Object.fromEntries(out.map((s) => [s.track.id, s.reason])),
    totalMs: total,
    discovered,
  }
}

export const AI_SUGGESTIONS = [
  '45 minutes of energetic coding music, mostly familiar, a few surprises',
  'Late night drive, cinematic, slowly winding down',
  'Rainy Sunday morning, acoustic and calm',
  'Gym session that builds up to a peak',
  'Songs like Arijit Singh but not sad',
  'Rediscover favourites I haven’t played in a while',
  'Something new — upbeat indie I’ve never heard',
  'An hour of deep focus, no aggressive tracks',
]
