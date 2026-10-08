import { useEffect, useMemo, useRef, useState } from 'react'
import { player, usePlayer, useProgress } from '../state/player'
import { useLyrics } from '../state/lyrics'
import { duration as fmt } from '../lib/format'
import type { Lyrics } from '../lib/lyrics'
import type { Track } from '../lib/types'

/** Deterministic noise per song, so the same song always draws the same shape. */
function seeded(seed: string) {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619)
  return () => {
    h += 0x6d2b79f5
    let t = h
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t) }

/**
 * The song's shape — a "song map", not an audio analysis (YouTube's audio isn't readable in the
 * browser): where the singing is (synced lyrics), choruses (repeated lines) higher, instrumental
 * breaks lower, the intro and outro tapering, all scaled by the song's energy.
 */
export function songShape(track: Track, lyrics: Lyrics | null, durationMs: number, bars: number): number[] {
  const rnd = seeded(track.id)
  const energy = track.energy ?? 0.5
  const lines = lyrics?.kind === 'synced' ? lyrics.lines : null
  const counts = new Map<string, number>()
  lines?.forEach((l) => { const k = l.text.toLowerCase().trim(); if (k) counts.set(k, (counts.get(k) ?? 0) + 1) })
  const out: number[] = []
  let li = 0
  for (let i = 0; i < bars; i++) {
    const x = (i + 0.5) / bars
    const t = x * durationMs
    const taper = smooth(0, 0.07, x) * (1 - smooth(0.9, 1, x))
    let section = 0.75
    if (lines?.length) {
      while (li < lines.length - 1 && lines[li + 1].start <= t) li++
      const l = lines[li]
      const sung = l && t >= l.start && t <= l.end && !!l.text.trim()
      const chorus = sung && (counts.get(l.text.toLowerCase().trim()) ?? 0) > 1
      section = sung ? (chorus ? 1.12 : 0.9) : 0.58
    } else {
      // No lyrics: a gentle verse–chorus swell.
      section = 0.72 + 0.28 * (0.5 + 0.5 * Math.sin(x * Math.PI * 4 - 1))
    }
    const noise = 0.78 + 0.44 * rnd()
    out.push(Math.max(0.06, Math.min(1, (0.38 + 0.62 * energy) * section * (0.25 + 0.75 * taper) * noise)))
  }
  // Soften neighbours so it reads as music, not static.
  return out.map((v, i) => (v * 2 + (out[i - 1] ?? v) + (out[i + 1] ?? v)) / 4)
}

export function Waveform({ track, bars = 140 }: { track: Track; bars?: number }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const lyrics = useLyrics((s) => s.lyrics)
  const durationMs = usePlayer((s) => s.duration) || track.durationMs || 0
  const playing = usePlayer((s) => s.isPlaying)
  const shape = useMemo(() => songShape(track, lyrics, durationMs || 200_000, bars), [track, lyrics, durationMs, bars])
  const [hover, setHover] = useState<number | null>(null)
  const drag = useRef(false)

  useEffect(() => {
    let raf = 0
    const draw = () => {
      raf = requestAnimationFrame(draw)
      const c = ref.current
      const el = box.current
      if (!c || !el) return
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      const w = el.clientWidth
      const h = el.clientHeight
      if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr) }
      const g = c.getContext('2d')
      if (!g) return
      g.setTransform(dpr, 0, 0, dpr, 0, 0)
      g.clearRect(0, 0, w, h)
      const { position, buffered } = useProgress.getState()
      const played = durationMs ? position / durationMs : 0
      const styles = getComputedStyle(el)
      const accent = styles.getPropertyValue('--accent').trim() || '#fff'
      const dim = styles.getPropertyValue('--wave-dim').trim() || 'rgba(255,255,255,0.22)'
      const buf = styles.getPropertyValue('--wave-buf').trim() || 'rgba(255,255,255,0.36)'
      const gap = 2
      const bw = Math.max(1.5, w / shape.length - gap)
      const now = performance.now() / 1000
      for (let i = 0; i < shape.length; i++) {
        const x = i * (bw + gap)
        const frac = (i + 0.5) / shape.length
        // Bars near the playhead breathe with the music while playing.
        const near = Math.abs(frac - played) * shape.length
        const live = playing && near < 6 ? 1 + 0.12 * (1 - near / 6) * Math.sin(now * 9 + i) : 1
        const bh = Math.max(2, shape[i] * h * 0.92 * live)
        const y = (h - bh) / 2
        g.fillStyle = frac <= played ? accent : hover != null && frac <= hover ? buf : frac <= buffered ? buf : dim
        g.beginPath()
        g.roundRect(x, y, bw, bh, bw / 2)
        g.fill()
      }
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [shape, durationMs, playing, hover])

  const at = (clientX: number) => {
    const r = box.current!.getBoundingClientRect()
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width))
  }
  return (
    <div
      ref={box}
      className="wave"
      role="slider"
      aria-label="Seek (song map)"
      title="Song map — shape estimated from the lyrics and energy"
      aria-valuemin={0}
      aria-valuemax={Math.round(durationMs / 1000)}
      tabIndex={0}
      onPointerDown={(e) => { drag.current = true; e.currentTarget.setPointerCapture(e.pointerId); setHover(at(e.clientX)) }}
      onPointerMove={(e) => setHover(at(e.clientX))}
      onPointerUp={(e) => { if (drag.current && durationMs) player().seek(at(e.clientX) * durationMs); drag.current = false }}
      onPointerLeave={() => { if (!drag.current) setHover(null) }}
      onKeyDown={(e) => {
        const pos = useProgress.getState().position
        if (e.key === 'ArrowRight') player().seek(pos + 5000)
        if (e.key === 'ArrowLeft') player().seek(Math.max(0, pos - 5000))
      }}
    >
      <canvas ref={ref} />
      {hover != null && durationMs > 0 && <span className="wave-tip" style={{ left: `${hover * 100}%` }}>{fmt(hover * durationMs)}</span>}
    </div>
  )
}

export function WaveTimes() {
  const pos = useProgress((s) => s.position)
  const d = usePlayer((s) => s.duration)
  return <div className="wave-times"><span>{fmt(pos)}</span><span>-{fmt(Math.max(0, d - pos))}</span></div>
}
