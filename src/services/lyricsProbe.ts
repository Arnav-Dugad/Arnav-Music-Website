/**
 * Read-only diagnostics for the lyrics engine (window.__arnavLyricsProbe): runs the same lookup
 * the player does for a song (by search query or video id) and reports every candidate, the pick
 * and the timing — used to test lyrics across languages.
 */
import { search, video } from '../lib/youtube'
import { verified } from './catalog'
import { fetchCredits } from '../lib/meta'
import { buildLyrics, findLyricsCandidates, rescore } from './lyricsEngine'
import type { Track } from '../lib/types'

const latinShare = (t: string) => { const l = t.match(/\p{L}/gu) ?? []; return l.length ? l.filter((c) => /[A-Za-zÀ-ɏ]/.test(c)).length / l.length : 1 }
const scriptOf = (t: string) => {
  if (/[؀-ۿ]/.test(t)) return 'arabic'
  if (/[਀-੿]/.test(t)) return 'gurmukhi'
  if (/[ऀ-ॿ]/.test(t)) return 'devanagari'
  return latinShare(t) > 0.7 ? 'latin' : 'other'
}

export async function lyricsProbe(input: { q?: string; v?: string }) {
  let track: Track | null = null
  if (input.v) track = await video(input.v)
  else if (input.q) track = verified((await search(input.q, 'SONGS')).tracks)[0] ?? null
  if (!track) return { error: 'no track' }
  let pick = await findLyricsCandidates(track, { force: true })
  let official: string | null = null
  if (!pick.candidates[0] || pick.candidates[0].score < 75) {
    official = (await fetchCredits(track).catch(() => null))?.lyrics ?? null
    if (official) pick = rescore(pick, track, official)
  }
  const chosen = pick.candidates.find((c) => c.key === pick.chosen) ?? null
  const built = chosen ? buildLyrics(track, pick, chosen) : null
  const firstSung = built?.lyrics.kind === 'synced' ? built.lyrics.lines.find((l) => l.text.trim()) : null
  return {
    track: { raw: track.rawTitle, title: track.title, artist: track.artist, album: track.album, channel: track.channelTitle, variant: track.variant, durationMs: track.durationMs, ref: track.playbackRef },
    itunes: pick.itunes ? { title: pick.itunes.title, artist: pick.itunes.artist, durationMs: pick.itunes.durationMs } : null,
    status: pick.status,
    chosen: chosen ? { key: chosen.key, source: chosen.source, title: chosen.title, artist: chosen.artist, durationMs: chosen.durationMs, score: chosen.score, reasons: chosen.reasons, synced: chosen.synced, script: scriptOf(chosen.raw) } : null,
    timing: built?.timing ?? null,
    firstLine: firstSung ? { at: firstSung.start, text: firstSung.text.slice(0, 60) } : null,
    official: official ? official.slice(0, 80) : null,
    others: pick.candidates.slice(0, 6).map((c) => `${c.score} ${c.source} "${c.title.slice(0, 40)}" — ${c.artist.slice(0, 30)} ${c.durationMs ? Math.round(c.durationMs / 1000) + 's' : ''} ${c.synced ? 'S' : 'P'} ${scriptOf(c.raw)} [${c.reasons.join(', ')}]`),
  }
}
