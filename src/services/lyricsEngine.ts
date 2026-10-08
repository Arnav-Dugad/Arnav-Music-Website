/**
 * Smart lyrics: finds every candidate (LRCLIB exact + two searches, NetEase, the version listeners
 * agreed on), scores them against what we know about the song (the audio release's exact length
 * from iTunes, title, credited artists, timestamps that make sense, the official lyrics in the
 * video description, your preferred script), then fits the timing to *this* upload: your own fix,
 * else the community's, else an automatic shift for music videos whose intro scenes push the song
 * later than the audio release the lyrics were timed to.
 */
import { idbGet, idbSet } from '../lib/idb'
import { titleSimilarity } from '../lib/classify'
import { cleanTitle, parseLrc, type LyricLine, type Lyrics } from '../lib/lyrics'
import { artistOverlap, fetchCommunity, itunesMatch, VARIANT, type CommunityTiming, type ItunesItem } from '../lib/meta'
import { useUsage } from '../lib/usage'
import { settings } from '../state/settings'
import { prefs } from '../state/prefs'
import type { Track } from '../lib/types'

export type LyricsSourceName = 'LRCLIB' | 'NetEase' | 'YouTube description' | 'Arnav AI' | 'You'

export interface LyricsCandidate {
  /** "lrclib:<id>" / "netease:<id>" / "desc" */
  key: string
  source: LyricsSourceName
  title: string
  artist: string
  album: string | null
  durationMs: number | null
  synced: boolean
  /** Word-level timestamps in the source (enhanced LRC). */
  wordTimed: boolean
  raw: string
  score: number
  reasons: string[]
}

export interface LyricsTiming {
  offsetMs: number
  scale: number
  source: 'you' | 'community' | 'auto' | 'none'
}

export interface LyricsPick {
  status: 'found' | 'instrumental' | 'none'
  candidates: LyricsCandidate[]
  chosen: string | null
  /** Length of the audio release (iTunes) — what synced lyrics are usually timed to. */
  referenceMs: number | null
  itunes: ItunesItem | null
  community: CommunityTiming | null
}

const CACHE = 'lyr|v5|'
const words = (s: string) => s.toLowerCase().normalize('NFKD').replace(/\p{M}+/gu, '').replace(/\(.*?\)|\[.*?\]/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

interface LrclibRecord { id?: number; trackName?: string; artistName?: string; albumName?: string; duration?: number; instrumental?: boolean; plainLyrics?: string | null; syncedLyrics?: string | null }

async function lrclib(ep: 'get' | 'search' | 'id', params: Record<string, string>): Promise<unknown> {
  const qs = new URLSearchParams({ ep, ...params })
  const r = await fetch(`/api/lyrics?${qs.toString()}`)
  if (r.status === 404) return null
  if (!r.ok) throw new Error(`lyrics ${r.status}`)
  return r.json()
}

async function netease(ep: 'search' | 'lyric', params: Record<string, string>): Promise<unknown> {
  const qs = new URLSearchParams({ src: 'netease', ep, ...params })
  const r = await fetch(`/api/meta?${qs.toString()}`).catch(() => null)
  return r?.ok ? r.json() : null
}

function fromLrclib(r: LrclibRecord): LyricsCandidate | null {
  const raw = r.syncedLyrics?.trim() || r.plainLyrics?.trim() || ''
  if (!raw && !r.instrumental) return null
  return {
    key: `lrclib:${r.id ?? 0}`, source: 'LRCLIB', title: r.trackName ?? '', artist: r.artistName ?? '', album: r.albumName ?? null,
    durationMs: r.duration ? Math.round(r.duration * 1000) : null, synced: !!r.syncedLyrics?.trim(),
    wordTimed: /<\d{1,3}:\d{2}/.test(r.syncedLyrics ?? ''), raw: raw || '[instrumental]', score: 0, reasons: [],
  }
}

/** Script share: how much of the text is Latin letters (romanised) vs another script. */
function latinShare(text: string): number {
  const letters = text.match(/\p{L}/gu) ?? []
  if (!letters.length) return 1
  return letters.filter((c) => /[A-Za-zÀ-ɏ]/.test(c)).length / letters.length
}

function tokensOf(text: string): Set<string> {
  return new Set(words(text.replace(/\[[^\]]*\]/g, ' ')).split(' ').filter((w) => w.length > 2))
}

/** Plain lines from LRC (no tags) — for comparing texts. */
const sungText = (raw: string) => raw.split('\n').map((l) => l.replace(/\[[^\]]*\]|<[^>]*>/g, '').trim()).filter(Boolean).join('\n')

function lastStamp(raw: string): number | null {
  const all = [...raw.matchAll(/\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g)]
  if (!all.length) return null
  const m = all[all.length - 1]
  return Number(m[1]) * 60_000 + Number(m[2]) * 1000 + (m[3] ? Number(m[3].padEnd(3, '0').slice(0, 3)) : 0)
}

/** Scores one candidate. Higher is better; below 35 it isn't shown. */
export function scoreCandidate(c: LyricsCandidate, ctx: { rawTitle?: string; title: string; artists: string; referenceMs: number | null; videoMs: number | null; isVideo: boolean; preferLatin: boolean | null; reference?: Set<string> | null; communityChoice?: string | null; communityVotes?: number; yourChoice?: string | null }): LyricsCandidate {
  const reasons: string[] = []
  let s = 0
  const sim = Math.max(titleSimilarity(words(c.title), words(ctx.title)), titleSimilarity(words(cleanTitle(c.title)), words(ctx.title)))
  s += 40 * sim
  if (sim < 0.6) { s -= 60; reasons.push('different title') }
  // A remix / reprise / acoustic take is another recording, with other words and timing.
  if (VARIANT.test(c.title.replace(/\s*[([](?:from|feat|ft)[^)\]]*[)\]]/gi, '')) && !VARIANT.test(ctx.rawTitle ?? ctx.title)) { s -= 45; reasons.push('another version') }
  if (artistOverlap(c.artist, ctx.artists)) { s += 18; reasons.push('same artist') } else s -= 12
  const ref = ctx.referenceMs
  if (c.durationMs && ref) {
    const dd = Math.abs(c.durationMs - ref) / 1000
    if (dd <= 2) { s += 26; reasons.push('exact length') } else if (dd <= 5) s += 16; else if (dd <= 10) s += 4; else if (dd <= 20) s -= 12; else { s -= 40; reasons.push('different length') }
  } else if (c.durationMs && ctx.videoMs) {
    // No audio release known: a music video can only be longer than the song.
    const extra = (ctx.videoMs - c.durationMs) / 1000
    if (Math.abs(extra) <= 3) s += 18
    else if (ctx.isVideo && extra > 0 && extra <= 70) s += 8
    else if (Math.abs(extra) > 25) s -= 25
  }
  if (c.synced) { s += 20; reasons.push('time-synced') }
  if (c.wordTimed) { s += 10; reasons.push('word timing') }
  if (c.synced) {
    const last = lastStamp(c.raw)
    const limit = Math.max(ref ?? 0, ctx.videoMs ?? 0)
    if (last && limit && last > limit + 8000) { s -= 35; reasons.push('timestamps past the end') }
  }
  const lines = sungText(c.raw).split('\n').length
  if (lines < 4 && !/instrumental/i.test(c.raw)) s -= 20
  if (ctx.preferLatin != null) {
    const latin = latinShare(c.raw) > 0.7
    if (latin === ctx.preferLatin) s += 8
  }
  if (ctx.reference?.size) {
    const mine = tokensOf(sungText(c.raw))
    let common = 0
    for (const w of mine) if (ctx.reference.has(w)) common++
    const ratio = mine.size ? common / Math.min(mine.size, ctx.reference.size) : 0
    s += 30 * ratio - (ratio < 0.15 ? 15 : 0)
    if (ratio >= 0.5) reasons.push('matches the official lyrics')
  }
  if (ctx.communityChoice === c.key) { s += 20 + 10 * Math.min(2, ctx.communityVotes ?? 1); reasons.push('chosen by listeners') }
  if (ctx.yourChoice === c.key) { s += 1000; reasons.push('your choice') }
  if (c.source === 'LRCLIB') s += 3
  return { ...c, score: Math.round(s), reasons }
}

/** All candidates for a song, best first (cached a week; your choice and timing apply on top). */
export async function findLyricsCandidates(track: Track, opts: { force?: boolean; descriptionLyrics?: string | null } = {}): Promise<LyricsPick> {
  const key = CACHE + track.id
  const cached = opts.force ? undefined : await idbGet<{ pick: LyricsPick; at: number }>(key, 'cache')
  const fresh = cached && Date.now() - cached.at < (cached.pick.status === 'found' ? 7 : 2) * 86_400_000
  const yourChoice = prefs().lyricsFix[track.id]?.choice ?? null
  if (cached && fresh && (!yourChoice || cached.pick.candidates.some((c) => c.key === yourChoice))) return rescore(cached.pick, track, opts.descriptionLyrics ?? null)
  useUsage.getState().bump({ lyricsLookups: 1 })

  const [itunes, community] = await Promise.all([itunesMatch(track).catch(() => null), fetchCommunity(track.playbackRef)])
  const title = cleanTitle(track.title)
  const artist = track.artist.split(',')[0].split(' & ')[0].split(' x ')[0].trim()
  const altTitle = itunes?.title ? cleanTitle(itunes.title) : null
  const altArtist = itunes?.artist?.split(/,|&/)[0]?.trim() ?? null
  const referenceMs = itunes?.durationMs ?? null
  const dur = Math.round((referenceMs ?? track.durationMs ?? 0) / 1000)
  const found = new Map<string, LyricsCandidate>()
  const add = (c: LyricsCandidate | null) => { if (c && !found.has(c.key)) found.set(c.key, c) }

  const tasks: Promise<void>[] = []
  if (dur > 0) {
    tasks.push(lrclib('get', { track_name: altTitle ?? title, artist_name: altArtist ?? artist, duration: String(dur), ...(itunes?.album ? { album_name: itunes.album } : track.album ? { album_name: track.album } : {}) })
      .then((r) => add(r ? fromLrclib(r as LrclibRecord) : null)).catch(() => undefined))
  }
  tasks.push(lrclib('search', { track_name: altTitle ?? title, artist_name: altArtist ?? artist }).then((r) => { for (const x of (r as LrclibRecord[] | null) ?? []) add(fromLrclib(x)) }).catch(() => undefined))
  tasks.push(lrclib('search', { q: `${title} ${artist}` }).then((r) => { for (const x of ((r as LrclibRecord[] | null) ?? []).slice(0, 12)) add(fromLrclib(x)) }).catch(() => undefined))
  // NetEase: big catalogue with good line timing for international songs.
  tasks.push((async () => {
    const r = (await netease('search', { q: `${altTitle ?? title} ${altArtist ?? artist}` })) as { results?: { id: string; title: string; durationMs: number; artists: string[]; album: string | null }[] } | null
    const ref = referenceMs ?? track.durationMs ?? null
    const hits = (r?.results ?? [])
      .filter((x) => titleSimilarity(words(x.title), words(title)) >= 0.7 && (!ref || Math.abs(x.durationMs - ref) < 12_000))
      .slice(0, 2)
    await Promise.all(hits.map(async (h) => {
      const l = (await netease('lyric', { id: h.id })) as { lrc: string | null } | null
      const raw = l?.lrc?.trim()
      // NetEase puts credits ("作词 : …") in the first lines: drop them.
      const clean = raw?.split('\n').filter((line) => !/^\s*\[[\d:.]+\]\s*(作词|作曲|编曲|制作人|混音|母带|和声|吉他|贝斯|鼓|录音|监制|出品|发行|词|曲)\s*[:：]/.test(line)).join('\n')
      if (clean && /\[\d{1,3}:\d{2}/.test(clean)) {
        add({ key: `netease:${h.id}`, source: 'NetEase', title: h.title, artist: h.artists.join(', '), album: h.album, durationMs: h.durationMs, synced: true, wordTimed: false, raw: clean, score: 0, reasons: [] })
      }
    }))
  })().catch(() => undefined))
  await Promise.all(tasks)

  // The version listeners (or you) picked, even if today's searches missed it.
  for (const choice of [yourChoice, community?.choice]) {
    if (!choice || found.has(choice)) continue
    const [src, id] = choice.split(':')
    if (src === 'lrclib') add(fromLrclib(((await lrclib('id', { id }).catch(() => null)) as LrclibRecord | null) ?? {}))
  }

  const instrumental = [...found.values()].some((c) => c.raw === '[instrumental]' && titleSimilarity(words(c.title), words(title)) >= 0.8 && artistOverlap(c.artist, `${track.artist}, ${track.credits ?? ''}`))
  const pick: LyricsPick = { status: 'none', candidates: [...found.values()].filter((c) => c.raw !== '[instrumental]'), chosen: null, referenceMs, itunes, community }
  const scored = rescore(pick, track, opts.descriptionLyrics ?? null)
  if (scored.status === 'none' && instrumental) scored.status = 'instrumental'
  void idbSet(key, { pick: scored, at: Date.now() }, 'cache')
  return scored
}

/** Re-ranks cached candidates (your choice / community / description may have changed). */
export function rescore(pick: LyricsPick, track: Track, descriptionLyrics: string | null): LyricsPick {
  const it = pick.itunes
  const preferLatin = settings().lyricsScript === 'latin' ? true : settings().lyricsScript === 'original' ? false : latinShare(track.title) > 0.7
  const ctx = {
    title: cleanTitle(track.title),
    rawTitle: track.rawTitle ?? track.title,
    artists: [track.artist, track.credits ?? '', it?.artist ?? ''].filter(Boolean).join(', '),
    referenceMs: pick.referenceMs,
    videoMs: track.durationMs ?? null,
    isVideo: track.variant !== 'SONG',
    preferLatin,
    reference: descriptionLyrics ? tokensOf(descriptionLyrics) : null,
    communityChoice: pick.community?.choice ?? null,
    communityVotes: pick.community?.votes ?? 0,
    yourChoice: prefs().lyricsFix[track.id]?.choice ?? null,
  }
  const seenText = new Set<string>()
  const candidates = pick.candidates.map((c) => scoreCandidate(c, ctx)).sort((a, b) => b.score - a.score)
    // The same lyrics uploaded twice (same words and timing) is one version.
    .filter((c) => { const k = `${c.synced ? 's' : 'p'}|${c.raw.replace(/\s+/g, ' ').slice(0, 400)}`; if (seenText.has(k)) return false; seenText.add(k); return true })
  const best = candidates[0]
  const ok = best && best.score >= 35
  return { ...pick, candidates, chosen: ok ? best.key : null, status: ok ? 'found' : pick.status === 'instrumental' ? 'instrumental' : 'none' }
}

/** How the chosen lyrics line up with this upload. */
export function timingFor(track: Track, pick: LyricsPick, chosen: LyricsCandidate): LyricsTiming {
  const mine = prefs().lyricsFix[track.id]
  if (mine && (mine.choice ?? chosen.key) === chosen.key && (mine.offsetMs != null || mine.scale != null)) {
    return { offsetMs: mine.offsetMs ?? 0, scale: mine.scale ?? 1, source: 'you' }
  }
  const c = pick.community
  if (c && c.choice === chosen.key && c.offsetMs != null && c.samples > 0) return { offsetMs: c.offsetMs, scale: c.scale ?? 1, source: 'community' }
  if (settings().autoAlignLyrics && chosen.synced && track.durationMs && track.variant !== 'SONG') {
    // Lyrics timed to the audio release; this is a music video with extra footage.
    const audio = pick.referenceMs && chosen.durationMs && Math.abs(pick.referenceMs - chosen.durationMs) <= 3000 ? pick.referenceMs : chosen.durationMs
    const extra = audio ? track.durationMs - audio : 0
    if (audio && extra >= 1500 && extra <= 60_000) return { offsetMs: extra, scale: 1, source: 'auto' }
  }
  return { offsetMs: 0, scale: 1, source: 'none' }
}

/** Applies a timing fix: t' = t·scale + offset (lines and words). */
export function shiftLines(lines: LyricLine[], offsetMs: number, scale: number): LyricLine[] {
  if (!offsetMs && scale === 1) return lines
  const f = (t: number) => Math.max(0, Math.round(t * scale + offsetMs))
  return lines.map((l) => ({
    ...l,
    start: l.start === 0 && !l.text ? 0 : f(l.start),
    end: f(l.end),
    words: l.words.map((w) => ({ ...w, start: f(w.start), end: f(w.end) })),
    backgroundWords: l.backgroundWords?.map((w) => ({ ...w, start: f(w.start), end: f(w.end) })),
  }))
}

/** Parsed, timing-fitted lyrics for a candidate. */
export function buildLyrics(track: Track, pick: LyricsPick, chosen: LyricsCandidate): { lyrics: Lyrics; timing: LyricsTiming } | null {
  const parsed = parseLrc(chosen.raw, track.durationMs, chosen.source)
  if (!parsed) return null
  const timing = timingFor(track, pick, chosen)
  if (parsed.kind !== 'synced') return { lyrics: parsed, timing: { offsetMs: 0, scale: 1, source: 'none' } }
  return { lyrics: { ...parsed, lines: shiftLines(parsed.lines, timing.offsetMs, timing.scale) }, timing }
}

/**
 * Robust straight-line fit of measured anchors (lyric time → video time): repeatedly drops the
 * worst point. Returns null unless at least four anchors agree within ~1.2 s.
 */
export function fitTiming(points: { lrc: number; video: number }[]): { offsetMs: number; scale: number; residualMs: number; used: number } | null {
  let pts = points.filter((p) => Number.isFinite(p.lrc) && Number.isFinite(p.video))
  const fit = (ps: typeof pts) => {
    const n = ps.length
    const mx = ps.reduce((a, p) => a + p.lrc, 0) / n
    const my = ps.reduce((a, p) => a + p.video, 0) / n
    const sxx = ps.reduce((a, p) => a + (p.lrc - mx) ** 2, 0)
    let scale = sxx > 0 ? ps.reduce((a, p) => a + (p.lrc - mx) * (p.video - my), 0) / sxx : 1
    if (!(scale > 0.9 && scale < 1.1)) scale = 1
    const offset = my - scale * mx
    const res = ps.map((p) => Math.abs(p.video - (p.lrc * scale + offset)))
    return { scale, offset, res }
  }
  while (pts.length >= 4) {
    const f = fit(pts)
    const worst = f.res.indexOf(Math.max(...f.res))
    if (f.res[worst] <= 1200) {
      const residualMs = f.res.reduce((a, b) => a + b, 0) / f.res.length
      return { offsetMs: Math.round(f.offset), scale: Math.abs(f.scale - 1) < 0.004 ? 1 : Math.round(f.scale * 10000) / 10000, residualMs: Math.round(residualMs), used: pts.length }
    }
    pts = pts.filter((_, i) => i !== worst)
  }
  return null
}
