import { djIntro } from '../lib/aiFeatures'
import { usePlayer, currentTrack } from '../state/player'
import { settings } from '../state/settings'
import { setDuck } from '../player/controller'
import type { Track } from '../lib/types'

/**
 * Arnav AI DJ: a short spoken intro as each new song starts (speech synthesis on this device,
 * text by Gemini or a template). The music ducks under the voice, then comes back up.
 */
const intros = new Map<string, Promise<string>>()
let lastSpokenKey: string | null = null
let prevTrack: Track | null = null

function voice(): SpeechSynthesisVoice | null {
  const voices = speechSynthesis.getVoices()
  const lang = (navigator.language || 'en').split('-')[0]
  return voices.find((v) => v.lang.startsWith(lang) && /natural|neural|premium|enhanced|google/i.test(v.name))
    ?? voices.find((v) => v.lang.startsWith(lang)) ?? voices[0] ?? null
}

function introFor(prev: Track | null, next: Track) {
  const k = `${prev?.id ?? ''}>${next.id}`
  if (!intros.has(k)) intros.set(k, djIntro(prev, next))
  return intros.get(k)!
}

export function speak(text: string) {
  if (!('speechSynthesis' in window)) return
  speechSynthesis.cancel()
  const u = new SpeechSynthesisUtterance(text)
  const v = voice()
  if (v) u.voice = v
  u.rate = 1.02
  u.pitch = 1
  u.onstart = () => setDuck(0.22)
  u.onend = () => setDuck(null)
  u.onerror = () => setDuck(null)
  speechSynthesis.speak(u)
}

export function startDj() {
  if (!('speechSynthesis' in window)) return
  speechSynthesis.getVoices()
  usePlayer.subscribe((s, prev) => {
    const key = s.queue[s.index]?.key ?? null
    const prevKey = prev.queue[prev.index]?.key ?? null
    if (key !== prevKey) {
      prevTrack = prev.queue[prev.index]?.track ?? prevTrack
      // Prefetch the intro for what comes after this song.
      const next = s.queue[s.index + 1]?.track
      const cur = s.queue[s.index]?.track
      if (settings().aiDj && cur && next) void introFor(cur, next)
    }
    if (!settings().aiDj) return
    // Speak once per song, when it actually starts playing.
    if (s.isPlaying && !prev.isPlaying && key && key !== lastSpokenKey) {
      lastSpokenKey = key
      const t = currentTrack(s)
      if (!t || !prevTrack || prevTrack.id === t.id) return
      void introFor(prevTrack, t).then((text) => { if (currentTrack()?.id === t.id && settings().aiDj) speak(text) })
    }
  })
}
