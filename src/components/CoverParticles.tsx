import { useEffect, useRef } from 'react'
import { proxied } from '../lib/color'
import { useSettings } from '../state/settings'

interface P { x: number; y: number; vx: number; vy: number; s: number; c: string; d: number }

/** The previous cover dissolves into particles as a new song's cover forms (the app's cover particles). */
export function CoverParticles({ id, art }: { id: string; art: string }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const prev = useRef<{ id: string; art: string } | null>(null)
  const enabled = useSettings((s) => s.coverParticles && s.motion === 'full')
  useEffect(() => {
    const before = prev.current
    prev.current = { id, art }
    const cv = ref.current
    if (!before || before.id === id || !enabled || !cv) return
    let raf = 0
    let cancelled = false
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.decoding = 'async'
    img.onload = () => {
      if (cancelled) return
      const rect = cv.getBoundingClientRect()
      const dpr = Math.min(2, devicePixelRatio || 1)
      const W = rect.width
      const H = rect.height
      cv.width = W * dpr
      cv.height = H * dpr
      const ctx = cv.getContext('2d')
      if (!ctx) return
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const N = 36
      const sample = document.createElement('canvas')
      sample.width = N
      sample.height = N
      const sctx = sample.getContext('2d', { willReadFrequently: true })
      if (!sctx) return
      const side = Math.min(img.naturalWidth, img.naturalHeight)
      try {
        sctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, N, N)
      } catch { return }
      let data: Uint8ClampedArray
      try { data = sctx.getImageData(0, 0, N, N).data } catch { return }
      // The canvas is 150% of the cover (so particles can fly past its edges); the cover sits centred.
      const cover = W / 1.5
      const pad = (W - cover) / 2
      const cell = cover / N
      const cx = W / 2
      const cy = H / 2
      const ps: P[] = []
      for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
          const i = (y * N + x) * 4
          const px = pad + x * cell + cell / 2
          const py = pad + y * cell + cell / 2
          const ang = Math.atan2(py - cy, px - cx) + (Math.random() - 0.5) * 0.9
          const dist = Math.hypot(px - cx, py - cy) / (cover / 2)
          const sp = (0.6 + Math.random() * 1.6) * (0.5 + dist)
          ps.push({ x: px, y: py, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp - 0.6, s: cell * 0.92, c: `rgb(${data[i]},${data[i + 1]},${data[i + 2]})`, d: Math.random() * 120 })
        }
      }
      const t0 = performance.now()
      const DUR = 950
      const frame = (now: number) => {
        const t = now - t0
        ctx.clearRect(0, 0, W, H)
        if (t > DUR + 150) return
        for (const p of ps) {
          const k = Math.max(0, t - p.d) / DUR
          if (k <= 0) { ctx.globalAlpha = 1; ctx.fillStyle = p.c; ctx.fillRect(p.x - p.s / 2, p.y - p.s / 2, p.s, p.s); continue }
          const e = 1 - Math.pow(1 - Math.min(1, k), 3)
          const size = p.s * (1 - e * 0.85)
          ctx.globalAlpha = Math.max(0, 1 - k * 1.1)
          ctx.fillStyle = p.c
          ctx.fillRect(p.x + p.vx * e * 90 - size / 2, p.y + p.vy * e * 90 - size / 2, size, size)
        }
        ctx.globalAlpha = 1
        raf = requestAnimationFrame(frame)
      }
      raf = requestAnimationFrame(frame)
    }
    img.src = proxied(before.art)
    return () => { cancelled = true; cancelAnimationFrame(raf); ref.current?.getContext('2d')?.clearRect(0, 0, ref.current.width, ref.current.height) }
  }, [id, art, enabled])
  return <canvas ref={ref} className="np-particles" aria-hidden />
}
