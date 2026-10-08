/**
 * Mood-matched automix: shortly before a hand-over, picks which of the next few songs continues the
 * moment best — matching how the current song ends (energy), tempo (Deezer BPM when known) and
 * genre — with Arnav AI choosing among the best few when it's available. Only reorders queues
 * where order isn't the point (shuffle, radio, mixes, AI sessions); playlists and albums keep theirs.
 */
import { create } from 'zustand'
import { generate, aiAvailability } from '../lib/ai'
import { idbGet } from '../lib/idb'
import { songShape } from '../components/Waveform'
import { currentTrack, player, usePlayer } from '../state/player'
import { useLyrics } from '../state/lyrics'
import { settings } from '../state/settings'
import type { CreditsResult } from '../lib/meta'
import type { Track } from '../lib/types'

export const useMoodPick = create<{ trackId: string | null; why: string | null }>()(() => ({ trackId: null, why: null }))

const FREE_ORDER = /radio|mix|session|for you|daily|arnav ai|queue chat|moment|discover|similar|endless|weather/i
let doneFor: string | null = null

async function bpmOf(t: Track): Promise<number | null> {
  const c = await idbGet<{ r: CreditsResult }>(`cr|v11|${t.playbackRef}`, 'cache')
  return c?.r.audio?.bpm ?? null
}
/** Tempo distance that treats half/double time as close (90 ≈ 180). */
function tempoGap(a: number, b: number): number {
  return Math.min(...[b, b * 2, b / 2].map((x) => Math.abs(Math.log2(x / a))))
}

export async function maybePickNext(): Promise<void> {
  const s = settings()
  const p = usePlayer.getState()
  const cur = currentTrack()
  const key = p.queue[p.index]?.key
  if (!s.moodAutomix || !cur || !key || doneFor === key) return
  if (!p.shuffle && !FREE_ORDER.test(p.context ?? '')) return
  doneFor = key
  const cands = p.queue.slice(p.index + 1, p.index + 7).map((q, i) => ({ q, i: p.index + 1 + i }))
  if (cands.length < 2) return
  // How the current song ends: its song-map level over the last 15%.
  const shape = songShape(cur, useLyrics.getState().lyrics, p.duration || cur.durationMs || 200_000, 60)
  const ending = shape.slice(-9).reduce((a, b) => a + b, 0) / 9
  const endEnergy = Math.min(1, Math.max(0, (cur.energy ?? 0.5) * 0.6 + ending * 0.4))
  const curBpm = await bpmOf(cur)
  const scored = await Promise.all(cands.map(async ({ q, i }) => {
    const t = q.track
    const bpm = await bpmOf(t)
    let score = 1 - Math.abs((t.energy ?? 0.5) - endEnergy) * 1.6
    if (curBpm && bpm) score += 0.5 - Math.min(0.5, tempoGap(curBpm, bpm) * 2.5)
    const shared = (t.genres ?? []).filter((g) => (cur.genres ?? []).includes(g)).length
    score += Math.min(0.3, shared * 0.15)
    if (t.artist === cur.artist) score -= 0.35
    score -= (i - p.index - 1) * 0.03 // a light preference for the original order
    return { t, i, bpm, score }
  }))
  scored.sort((a, b) => b.score - a.score)
  let pick = scored[0]
  let why: string | null = null
  // Arnav AI chooses among the best few, with a short reason.
  if (!aiAvailability() && s.aiEnabled) {
    const top = scored.slice(0, 4)
    const desc = (t: Track, bpm: number | null) => `"${t.title}" by ${t.artist} (energy ${(t.energy ?? 0.5).toFixed(2)}${bpm ? `, ${Math.round(bpm)} BPM` : ''}${t.genres?.length ? `, ${t.genres.slice(0, 2).join('/')}` : ''})`
    const prompt = `A DJ is about to blend out of ${desc(cur, curBpm)}, which ends at energy ${endEnergy.toFixed(2)}.
Which of these should play next for the smoothest, most fitting transition?
${top.map((x, n) => `${n + 1}. ${desc(x.t, x.bpm)}`).join('\n')}
Reply with JSON only: {"pick":1,"why":"at most 8 words"}`
    const r = await generate(prompt, 'mood-next-v1', { json: true, maxOutputTokens: 120, temperature: 0.2, cacheTtlMs: 30 * 86_400_000 }).catch(() => null)
    if (r?.ok) {
      try {
        const j = JSON.parse(r.text.replace(/```[a-z]*\n?|```/g, '')) as { pick?: number; why?: string }
        if (typeof j.pick === 'number' && top[j.pick - 1]) { pick = top[j.pick - 1]; why = typeof j.why === 'string' ? j.why.slice(0, 60) : null }
      } catch { /* keep the local pick */ }
    }
  }
  if (!why) {
    const d = (pick.t.energy ?? 0.5) - endEnergy
    why = Math.abs(d) < 0.12 ? 'keeps the same energy' : d > 0 ? 'lifts the energy' : 'eases the energy down'
  }
  // Still the same song playing? Move the pick to play next.
  const now = usePlayer.getState()
  if (now.queue[now.index]?.key !== key) return
  const from = now.queue.findIndex((q) => q.track.id === pick.t.id)
  if (from > now.index + 1) player().move(from, now.index + 1)
  useMoodPick.setState({ trackId: pick.t.id, why })
}
