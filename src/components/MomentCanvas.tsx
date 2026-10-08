import { useEffect, useRef } from 'react'
import type { Moment } from '../lib/moments'
import { usePlayer } from '../state/player'
import { useSettings } from '../state/settings'
import { parseHex } from '../lib/color'

interface P { x: number; y: number; vx: number; vy: number; r: number; a: number; life: number }

/** Procedural environment for a Moment — no images, no AI image generation. */
export function MomentCanvas({ m }: { m: Moment }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const motion = useSettings((s) => s.motion)
  useEffect(() => {
    const cv = ref.current
    if (!cv) return
    const ctx = cv.getContext('2d')!
    const [c1, c2, c3] = m.palette.map(parseHex)
    const rgba = (c: number[], a: number) => `rgba(${c[0]},${c[1]},${c[2]},${a})`
    let w = 0, h = 0, dpr = 1
    const resize = () => {
      dpr = Math.min(2, devicePixelRatio || 1)
      w = cv.clientWidth; h = cv.clientHeight
      cv.width = w * dpr; cv.height = h * dpr
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(cv)
    const speed = motion === 'off' ? 0 : motion === 'reduced' ? 0.3 : 1
    const ps: P[] = []
    const count = m.motion === 'RAIN' ? 220 : m.motion === 'SHIMMER' ? 90 : m.motion === 'SURGE' ? 70 : 26
    const spawn = (init: boolean): P => {
      switch (m.motion) {
        case 'RAIN': return { x: Math.random() * w, y: init ? Math.random() * h : -20, vx: -0.6, vy: 9 + Math.random() * 7, r: 10 + Math.random() * 16, a: 0.12 + Math.random() * 0.25, life: 1 }
        case 'SHIMMER': return { x: Math.random() * w, y: Math.random() * h, vx: (Math.random() - 0.5) * 0.15, vy: -0.1 - Math.random() * 0.3, r: 0.6 + Math.random() * 1.8, a: Math.random(), life: Math.random() }
        case 'SURGE': return { x: init ? Math.random() * w : -200, y: Math.random() * h, vx: 8 + Math.random() * 14, vy: -2 - Math.random() * 2, r: 60 + Math.random() * 160, a: 0.06 + Math.random() * 0.12, life: 1 }
        default: return { x: Math.random() * w, y: Math.random() * h, vx: (Math.random() - 0.5) * 0.25, vy: (Math.random() - 0.5) * 0.25, r: 80 + Math.random() * 220, a: 0.1 + Math.random() * 0.18, life: 1 }
      }
    }
    for (let i = 0; i < count; i++) ps.push(spawn(true))
    let raf = 0
    let t0 = performance.now()
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame)
      const dt = Math.min(50, now - t0) / 16.67 * speed
      t0 = now
      const t = now / 1000
      const playing = usePlayer.getState().isPlaying
      const energy = m.aesthetic.energy
      // Base gradient
      const g = ctx.createLinearGradient(0, 0, w * 0.4, h)
      g.addColorStop(0, rgba(c1, 1)); g.addColorStop(0.6, rgba(c2, 1)); g.addColorStop(1, rgba(c1, 1))
      ctx.globalCompositeOperation = 'source-over'
      ctx.fillStyle = g
      ctx.fillRect(0, 0, w, h)
      ctx.globalCompositeOperation = 'lighter'
      if (m.motion === 'PULSE') {
        const bpm = 90 + energy * 50
        const beat = (t * bpm / 60) % 1
        for (let i = 0; i < 4; i++) {
          const p = (beat + i / 4) % 1
          ctx.strokeStyle = rgba(c3, (1 - p) * (playing ? 0.35 : 0.15))
          ctx.lineWidth = 2 + (1 - p) * 6
          ctx.beginPath(); ctx.arc(w * 0.5, h * 0.55, p * Math.max(w, h) * 0.6, 0, Math.PI * 2); ctx.stroke()
        }
      }
      if (m.motion === 'STILL') {
        const r = Math.max(w, h) * (0.45 + 0.04 * Math.sin(t * 0.4))
        const rg = ctx.createRadialGradient(w * 0.62, h * 0.38, 0, w * 0.62, h * 0.38, r)
        rg.addColorStop(0, rgba(c3, 0.32)); rg.addColorStop(1, rgba(c3, 0))
        ctx.fillStyle = rg; ctx.fillRect(0, 0, w, h)
      }
      if (m.id === 'night_drive') {
        // Neon road lines receding to a horizon.
        ctx.strokeStyle = rgba(c3, 0.35)
        ctx.lineWidth = 2
        const hy = h * 0.62
        for (let i = 0; i < 14; i++) {
          const z = ((i / 14) + t * 0.25 * speed) % 1
          const y = hy + Math.pow(z, 2.2) * (h - hy)
          ctx.globalAlpha = z
          ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke()
        }
        ctx.globalAlpha = 1
        for (let i = -6; i <= 6; i++) { ctx.beginPath(); ctx.moveTo(w / 2 + i * 12, hy); ctx.lineTo(w / 2 + i * w * 0.18, h); ctx.stroke() }
        const sun = ctx.createRadialGradient(w / 2, hy, 0, w / 2, hy, h * 0.3)
        sun.addColorStop(0, rgba(c3, 0.5)); sun.addColorStop(1, rgba(c3, 0))
        ctx.fillStyle = sun; ctx.fillRect(0, 0, w, h)
      }
      for (let i = 0; i < ps.length; i++) {
        const p = ps[i]
        p.x += p.vx * dt * (playing ? 1 : 0.5)
        p.y += p.vy * dt * (playing ? 1 : 0.5)
        if (m.motion === 'RAIN') {
          ctx.strokeStyle = rgba([220, 235, 255], p.a)
          ctx.lineWidth = 1
          ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x + p.vx * 2, p.y + p.r); ctx.stroke()
          if (p.y > h) ps[i] = spawn(false)
        } else if (m.motion === 'SHIMMER') {
          p.life += 0.008 * dt
          const a = Math.max(0, Math.sin(p.life * Math.PI)) * 0.9
          ctx.fillStyle = rgba(c3, a)
          ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill()
          if (p.life > 1) ps[i] = { ...spawn(false), life: 0 }
        } else if (m.motion === 'SURGE') {
          const lg = ctx.createLinearGradient(p.x - p.r, p.y, p.x, p.y)
          lg.addColorStop(0, rgba(c3, 0)); lg.addColorStop(1, rgba(c3, p.a * (playing ? 1.6 : 0.8)))
          ctx.strokeStyle = lg
          ctx.lineWidth = 2
          ctx.beginPath(); ctx.moveTo(p.x - p.r, p.y - p.vy * 6); ctx.lineTo(p.x, p.y); ctx.stroke()
          if (p.x - p.r > w) ps[i] = spawn(false)
        } else {
          if (p.x < -p.r) p.x = w + p.r; if (p.x > w + p.r) p.x = -p.r
          if (p.y < -p.r) p.y = h + p.r; if (p.y > h + p.r) p.y = -p.r
          const col = i % 2 ? c3 : c2
          const rg = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r)
          rg.addColorStop(0, rgba(col, p.a * (m.motion === 'STILL' ? 0.5 : 1)))
          rg.addColorStop(1, rgba(col, 0))
          ctx.fillStyle = rg
          ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill()
        }
      }
      ctx.globalCompositeOperation = 'source-over'
      const vg = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.2, w / 2, h / 2, Math.max(w, h) * 0.75)
      vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.55)')
      ctx.fillStyle = vg; ctx.fillRect(0, 0, w, h)
    }
    raf = requestAnimationFrame(frame)
    return () => { cancelAnimationFrame(raf); ro.disconnect() }
  }, [m, motion])
  return <canvas ref={ref} className="moment-canvas" aria-hidden />
}
