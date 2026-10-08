import { getAI, getGenerativeModel, GoogleAIBackend, type Part } from 'firebase/ai'
import { fetchAndActivate, getRemoteConfig, getValue, type RemoteConfig } from 'firebase/remote-config'
import { firebaseApp } from './firebase'
import { idbGet, idbSet } from './idb'
import { useUsage } from './usage'
import { settings } from '../state/settings'
import type { Track } from './types'

export type AiUnavailable = 'DISABLED_BY_USER' | 'NOT_CONFIGURED' | 'DAILY_LIMIT' | 'THROTTLED' | 'QUOTA' | 'APP_CHECK' | 'OFFLINE' | 'TIMEOUT' | 'MALFORMED' | 'ERROR'
export type AiOutcome = { ok: true; text: string; cached: boolean; model: string } | { ok: false; reason: AiUnavailable }

export const AI_REASON_COPY: Record<AiUnavailable, string> = {
  DISABLED_BY_USER: 'Arnav AI cloud is off in Settings — answered on device.',
  NOT_CONFIGURED: 'Cloud AI is unavailable — answered on device.',
  DAILY_LIMIT: 'Today’s Arnav AI limit is reached — answered on device.',
  THROTTLED: 'One moment between requests — answered on device.',
  QUOTA: 'Gemini’s free quota is busy — answered on device.',
  APP_CHECK: 'Cloud AI rejected this browser — answered on device.',
  OFFLINE: 'Offline — answered on device.',
  TIMEOUT: 'Gemini took too long — answered on device.',
  MALFORMED: 'Gemini’s answer was unusable — answered on device.',
  ERROR: 'Cloud AI failed — answered on device.',
}

interface Tunables { aiEnabled: boolean; aiModel: string; temperature: number; maxOutputTokens: number; minIntervalMs: number; timeoutMs: number }
const DEFAULTS: Tunables = { aiEnabled: true, aiModel: 'gemini-3.5-flash-lite', temperature: 0.6, maxOutputTokens: 1200, minIntervalMs: 4000, timeoutMs: 20000 }
/** Models retired by Google are skipped automatically; the first available answers. */
const FALLBACK_MODELS = ['gemini-3.5-flash-lite', 'gemini-flash-lite-latest']
const RETIRED = /^gemini-(1\.|2\.0|2\.5)/

let tunables: Tunables = DEFAULTS
let rc: RemoteConfig | null = null
let rcLoaded: Promise<void> | null = null
let lastCallAt = 0
let quotaBlockedUntil = 0
let appCheckBlockedUntil = 0
let deadModels = new Set<string>()
export let lastAiError: string | null = null

function loadRemoteConfig(): Promise<void> {
  if (rcLoaded) return rcLoaded
  rcLoaded = (async () => {
    try {
      rc = getRemoteConfig(firebaseApp())
      rc.settings.minimumFetchIntervalMillis = 6 * 3600_000
      rc.settings.fetchTimeoutMillis = 4000
      rc.defaultConfig = {
        ai_enabled: true, ai_model: DEFAULTS.aiModel, ai_temperature: DEFAULTS.temperature,
        ai_max_output_tokens: DEFAULTS.maxOutputTokens, ai_min_interval_ms: DEFAULTS.minIntervalMs, ai_timeout_ms: DEFAULTS.timeoutMs,
      }
      await Promise.race([fetchAndActivate(rc), new Promise((r) => setTimeout(r, 4500))])
      const model = getValue(rc, 'ai_model').asString() || DEFAULTS.aiModel
      tunables = {
        aiEnabled: getValue(rc, 'ai_enabled').asBoolean(),
        aiModel: RETIRED.test(model) ? DEFAULTS.aiModel : model,
        temperature: getValue(rc, 'ai_temperature').asNumber() || DEFAULTS.temperature,
        maxOutputTokens: Math.max(DEFAULTS.maxOutputTokens, getValue(rc, 'ai_max_output_tokens').asNumber() || 0),
        minIntervalMs: getValue(rc, 'ai_min_interval_ms').asNumber() || DEFAULTS.minIntervalMs,
        timeoutMs: getValue(rc, 'ai_timeout_ms').asNumber() || DEFAULTS.timeoutMs,
      }
    } catch {
      tunables = DEFAULTS
    }
  })()
  return rcLoaded
}

export function aiAvailability(): AiUnavailable | null {
  const s = settings()
  if (!s.aiEnabled) return 'DISABLED_BY_USER'
  if (!tunables.aiEnabled) return 'NOT_CONFIGURED'
  if (useUsage.getState().aiRequests >= s.dailyAiLimit) return 'DAILY_LIMIT'
  if (Date.now() < quotaBlockedUntil) return 'QUOTA'
  if (Date.now() < appCheckBlockedUntil) return 'APP_CHECK'
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'OFFLINE'
  return null
}

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function classify(e: unknown): AiUnavailable {
  const msg = (e instanceof Error ? e.message : String(e)).toLowerCase()
  lastAiError = msg.slice(0, 200)
  if (msg.includes('app check') || msg.includes('appcheck') || msg.includes('attestation')) {
    appCheckBlockedUntil = Date.now() + 6 * 3600_000
    return 'APP_CHECK'
  }
  if (msg.includes('quota') || msg.includes('429') || msg.includes('resource_exhausted') || msg.includes('rate')) {
    quotaBlockedUntil = Date.now() + 3600_000
    return 'QUOTA'
  }
  if (msg.includes('network') || msg.includes('failed to fetch')) return 'OFFLINE'
  return 'ERROR'
}

const isModelGone = (e: unknown) => /not.?found|404|no longer available|is not supported/i.test(e instanceof Error ? e.message : String(e))

function timeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('__timeout__')), ms)
    p.then((v) => { clearTimeout(t); resolve(v) }, (e) => { clearTimeout(t); reject(e) })
  })
}

/**
 * The only door to Gemini (Firebase AI Logic, Gemini Developer API).
 * Guarantees: consent, daily cap, min-interval throttle, versioned 7-day cache, timeout,
 * no retries on quota errors, automatic model fallback. Callers always have a local fallback.
 */
export async function generate(prompt: string | Part[], version: string, opts: { json?: boolean; cacheTtlMs?: number; timeoutMs?: number; maxOutputTokens?: number; temperature?: number; skipThrottle?: boolean } = {}): Promise<AiOutcome> {
  await loadRemoteConfig()
  const keyText = typeof prompt === 'string' ? prompt : JSON.stringify(prompt)
  const key = `ai|${version}|${await sha256(keyText)}`
  const ttl = opts.cacheTtlMs ?? 7 * 86_400_000
  const hit = await idbGet<{ text: string; at: number; model: string }>(key, 'cache')
  if (hit && Date.now() - hit.at < ttl) {
    useUsage.getState().bump({ aiCacheHits: 1 })
    return { ok: true, text: hit.text, cached: true, model: hit.model }
  }
  const blocked = aiAvailability()
  if (blocked) return { ok: false, reason: blocked }
  if (!opts.skipThrottle && Date.now() - lastCallAt < tunables.minIntervalMs) return { ok: false, reason: 'THROTTLED' }
  lastCallAt = Date.now()

  const models = [...new Set([tunables.aiModel, ...FALLBACK_MODELS])].filter((m) => !deadModels.has(m))
  for (const modelName of models) {
    useUsage.getState().bump({ aiRequests: 1 })
    try {
      const ai = getAI(firebaseApp(), { backend: new GoogleAIBackend() })
      const model = getGenerativeModel(ai, {
        model: modelName,
        generationConfig: {
          temperature: opts.temperature ?? tunables.temperature,
          maxOutputTokens: opts.maxOutputTokens ?? tunables.maxOutputTokens,
          ...(opts.json ? { responseMimeType: 'application/json' } : {}),
        },
      })
      const result = await timeout(model.generateContent(prompt), opts.timeoutMs ?? tunables.timeoutMs)
      const text = result.response.text()
      if (!text?.trim()) return { ok: false, reason: 'MALFORMED' }
      void idbSet(key, { text, at: Date.now(), model: modelName }, 'cache')
      return { ok: true, text, cached: false, model: modelName }
    } catch (e) {
      if (e instanceof Error && e.message === '__timeout__') return { ok: false, reason: 'TIMEOUT' }
      if (isModelGone(e)) { deadModels = new Set([...deadModels, modelName]); continue }
      return { ok: false, reason: classify(e) }
    }
  }
  return { ok: false, reason: 'NOT_CONFIGURED' }
}

export function noteFallback() {
  useUsage.getState().bump({ aiFallbacks: 1 })
}

// ── Lyrics: translation + romanisation (web upgrade of the app's on-device ML Kit) ───────────
export async function translateLyrics(lines: string[], language: string): Promise<{ translation: string[]; romanized: string[] } | null> {
  const body = lines.map((l, i) => `${i}\t${l}`).join('\n')
  const prompt = `Translate these song lyric lines into ${language}. Also give a Latin-letter romanisation of each ORIGINAL line (empty string if it is already in Latin letters).
Keep line count and order exactly. Lines are "index<TAB>text". Blank text stays blank.
Respond ONLY with JSON: {"translation":[string],"romanized":[string]} with exactly ${lines.length} items each.
${body}`
  const r = await generate(prompt, 'lyrics-translate-v1', { json: true, maxOutputTokens: 4096, timeoutMs: 40000, cacheTtlMs: 365 * 86_400_000, skipThrottle: true })
  if (!r.ok) return null
  try {
    const parsed = JSON.parse(r.text.slice(r.text.indexOf('{'), r.text.lastIndexOf('}') + 1)) as { translation?: unknown; romanized?: unknown }
    const t = Array.isArray(parsed.translation) ? parsed.translation.map(String) : []
    const ro = Array.isArray(parsed.romanized) ? parsed.romanized.map(String) : []
    if (t.length !== lines.length) return null
    return { translation: t, romanized: ro.length === lines.length ? ro : lines.map(() => '') }
  } catch {
    return null
  }
}

// ── Arnav AI lyrics: transcription from the public YouTube link (labelled AI-written) ─────
const NO_VOCALS = 'NO_VOCALS'
export type Transcription = { ok: true; text: string; model: string } | { ok: false; reason: string }

export async function transcribeLyrics(track: Track): Promise<Transcription> {
  const url = `https://www.youtube.com/watch?v=${track.playbackRef}`
  if (!/^https:\/\/www\.youtube\.com\/watch\?v=[A-Za-z0-9_-]{11}$/.test(url)) return { ok: false, reason: 'input' }
  const instruction = `Transcribe the sung lyrics of this recording exactly as they are sung.
It is probably "${track.title.slice(0, 120)}" by ${track.artist.slice(0, 80)}. Use that only to spell names; write what is actually sung.

Rules:
- Output only LRC lines: one sung line per line, each starting with the time it starts being sung, as [mm:ss.xx].
- Keep the original language and script of every line. Do not translate or romanise.
- Put an empty line between sections (verse, chorus, bridge). Repeat repeated lines every time they are sung.
- For a long passage without singing you may write a line like [01:23.00] [instrumental].
- No title, no section names, no notes, no explanations, no markdown.
- If nobody sings in this recording, output exactly: ${NO_VOCALS}
`
  const parts: Part[] = [{ type: 'fileData', fileData: { mimeType: 'video/mp4', fileUri: url } }, { type: 'text', text: instruction }]
  const r = await generate(parts, 'transcribe-v1', { maxOutputTokens: 8192, timeoutMs: 120000, temperature: 0.2, cacheTtlMs: 365 * 86_400_000, skipThrottle: true })
  if (!r.ok) return { ok: false, reason: r.reason }
  const text = r.text.replace(/```[a-z]*\n?|```/g, '').trim()
  if (text.includes(NO_VOCALS)) return { ok: false, reason: 'no vocals' }
  const lrcLines = text.split('\n').filter((l) => /^\s*\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\]/.test(l))
  if (lrcLines.length < 4) return { ok: false, reason: /sorry|can't|cannot|unable/i.test(text) ? 'refusal' : 'too short' }
  const distinct = new Set(lrcLines.map((l) => l.replace(/^\s*\[[^\]]+\]/, '').trim().toLowerCase())).size
  if (distinct < 3) return { ok: false, reason: 'repetitive' }
  return { ok: true, text: lrcLines.join('\n'), model: r.model }
}

/** One-line, fact-bound explanation for a recommendation (cached for a week). */
export async function explain(track: Track, signals: string[]): Promise<string | null> {
  const prompt = `In one short sentence (max 14 words), explain to a listener why "${track.title}" by ${track.artist} was suggested.
Use ONLY these facts: ${signals.join('; ')}. Do not guess feelings or circumstances. Plain text.`
  const r = await generate(prompt, 'explain-v1', { maxOutputTokens: 200 })
  return r.ok ? r.text.trim().replace(/^"|"$/g, '') : null
}
