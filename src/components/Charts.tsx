import { useMemo, useRef, useState, useEffect, type ReactNode } from 'react'
import { motion } from 'motion/react'
import { energyAt, type SessionConstraints } from '../lib/intent'
import type { Track } from '../lib/types'
import { hourLabel } from '../lib/taste'

/** Shared hover tooltip positioned inside a relative container. */
function Tip({ x, y, children }: { x: number | string; y: number; children: ReactNode }) {
  return <div className="chart-tip" style={{ left: x, top: y }}>{children}</div>
}

/** Energy curve (target line) with each song's estimated energy as a marker. */
export function EnergyChart({ constraints, tracks, height = 150 }: { constraints: SessionConstraints; tracks: Track[]; height?: number }) {
  const W = 600
  const H = height
  const pad = { l: 8, r: 8, t: 14, b: 22 }
  const [hover, setHover] = useState<number | null>(null)
  const total = tracks.reduce((a, t) => a + (t.durationMs ?? 210_000), 0) || 1
  const points = useMemo(() => {
    let acc = 0
    return tracks.map((t) => {
      const d = t.durationMs ?? 210_000
      const mid = (acc + d / 2) / total
      acc += d
      return { x: pad.l + mid * (W - pad.l - pad.r), e: t.energy, target: energyAt(constraints, mid), t }
    })
  }, [tracks, constraints, total]) // eslint-disable-line react-hooks/exhaustive-deps
  const y = (e: number) => pad.t + (1 - e) * (H - pad.t - pad.b)
  const curve = Array.from({ length: 61 }, (_, i) => {
    const p = i / 60
    return `${i ? 'L' : 'M'}${(pad.l + p * (W - pad.l - pad.r)).toFixed(1)},${y(energyAt(constraints, p)).toFixed(1)}`
  }).join(' ')
  return (
    <div className="chart" style={{ position: 'relative' }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" role="img" aria-label={`Energy curve: ${constraints.energyCurve.toLowerCase()}, target ${Math.round(constraints.energyTarget * 100)}%`}>
        {[0.25, 0.5, 0.75].map((g) => <line key={g} x1={pad.l} x2={W - pad.r} y1={y(g)} y2={y(g)} stroke="var(--hairline)" strokeWidth={1} vectorEffect="non-scaling-stroke" />)}
        <motion.path d={curve} fill="none" stroke="var(--accent)" strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinecap="round"
          initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 1.1, ease: [0.32, 0.72, 0, 1] }} />
        <path d={`${curve} L${W - pad.r},${H - pad.b} L${pad.l},${H - pad.b} Z`} fill="color-mix(in oklab, var(--accent) 12%, transparent)" />
      </svg>
      <div className="chart-overlay" style={{ height: H }}>
        {points.map((p, i) => (
          <button key={p.t.id} className="chart-dot-hit" style={{ left: `${(p.x / W) * 100}%`, top: y(p.e ?? p.target) }}
            onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(i)} onBlur={() => setHover(null)} aria-label={`${p.t.title}: energy ${p.e != null ? Math.round(p.e * 100) + '%' : 'unknown'}`}>
            <motion.span className={`chart-dot ${p.e == null ? 'unknown' : ''}`} initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ delay: 0.4 + i * 0.03, type: 'spring', stiffness: 400, damping: 20 }} />
          </button>
        ))}
        {hover != null && points[hover] && (
          <Tip x={`${(points[hover].x / W) * 100}%`} y={y(points[hover].e ?? points[hover].target)}>
            <b>{points[hover].t.title}</b><br />
            {points[hover].e != null ? `Energy ${Math.round(points[hover].e! * 100)}%` : 'Energy unknown'} · target {Math.round(points[hover].target * 100)}%
          </Tip>
        )}
      </div>
      <div className="chart-axis t-caption"><span>Start</span><span>{constraints.durationMinutes} min</span></div>
    </div>
  )
}

/** 24-hour radial listening clock (single series, magnitude → bar length). */
export function ListeningClock({ hours, size = 260 }: { hours: number[]; size?: number }) {
  const max = Math.max(1, ...hours)
  const [hover, setHover] = useState<number | null>(null)
  const c = size / 2
  const inner = size * 0.19
  const outer = size * 0.38
  const peak = hours.indexOf(max)
  return (
    <div className="clock" style={{ width: size, height: size }}>
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} role="img" aria-label={`Listening by hour; most at ${hourLabel(peak)}`}>
        <circle cx={c} cy={c} r={inner} fill="none" stroke="var(--hairline)" />
        <circle cx={c} cy={c} r={outer} fill="none" stroke="var(--hairline)" strokeDasharray="2 4" />
        {hours.map((v, h) => {
          const a = ((h / 24) * 360 - 90) * (Math.PI / 180)
          const len = inner + 4 + (v / max) * (outer - inner - 4)
          const x1 = c + Math.cos(a) * inner
          const y1 = c + Math.sin(a) * inner
          const x2 = c + Math.cos(a) * len
          const y2 = c + Math.sin(a) * len
          return (
            <g key={h} onMouseEnter={() => setHover(h)} onMouseLeave={() => setHover(null)}>
              <line x1={c + Math.cos(a) * inner} y1={c + Math.sin(a) * inner} x2={c + Math.cos(a) * outer} y2={c + Math.sin(a) * outer} stroke="transparent" strokeWidth={14} />
              <motion.line x1={x1} y1={y1} x2={x2} y2={y2} stroke={h === hover || h === peak ? 'var(--accent)' : 'color-mix(in oklab, var(--accent) 55%, var(--text-3))'} strokeWidth={6} strokeLinecap="round"
                initial={{ pathLength: 0, opacity: 0 }} animate={{ pathLength: 1, opacity: v > 0 ? 1 : 0.25 }} transition={{ delay: h * 0.02, duration: 0.6 }} />
            </g>
          )
        })}
        {[0, 6, 12, 18].map((h) => {
          const a = ((h / 24) * 360 - 90) * (Math.PI / 180)
          return <text key={h} x={c + Math.cos(a) * (outer + 18)} y={c + Math.sin(a) * (outer + 18) + 4} textAnchor="middle" fontSize={10} fill="var(--text-3)">{hourLabel(h)}</text>
        })}
      </svg>
      <div className="clock-center">
        <div className="t-caption">{hover != null ? hourLabel(hover) : 'Peak'}</div>
        <div className="clock-v">{hover != null ? `${Math.round(hours[hover])}m` : hourLabel(peak)}</div>
      </div>
    </div>
  )
}

export function Bars({ values, labels, height = 140, unit = 'min' }: { values: number[]; labels: string[]; height?: number; unit?: string }) {
  const max = Math.max(1, ...values)
  return (
    <div className="bars" style={{ height }}>
      {values.map((v, i) => (
        <div key={i} className="bar-col" title={`${labels[i]}: ${Math.round(v)} ${unit}`}>
          <div className="bar-track">
            <motion.div className="bar-fill" initial={{ scaleY: 0 }} whileInView={{ scaleY: Math.max(0.02, v / max) }} viewport={{ once: true }} transition={{ type: 'spring', stiffness: 140, damping: 20, delay: i * 0.04 }} />
          </div>
          <span className="t-caption">{labels[i]}</span>
        </div>
      ))}
    </div>
  )
}

/** GitHub-style listening calendar: one hue, light → dark by minutes. */
export function Heatmap({ days, onPick }: { days: { day: number; minutes: number }[]; onPick?: (d: { day: number; minutes: number }) => void }) {
  const max = Math.max(1, ...days.map((d) => d.minutes))
  const ref = useRef<HTMLDivElement>(null)
  const [tip, setTip] = useState<{ x: number; y: number; d: { day: number; minutes: number } } | null>(null)
  const first = days[0] ? new Date(days[0].day).getDay() : 0
  const cells = [...Array((first + 6) % 7).fill(null), ...days]
  const weeks: ({ day: number; minutes: number } | null)[][] = []
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7))
  useEffect(() => { ref.current?.scrollTo({ left: ref.current.scrollWidth }) }, [days.length])
  const level = (m: number) => (m <= 0 ? 0 : Math.min(4, 1 + Math.floor((m / max) * 3.999)))
  return (
    <div className="heat-wrap">
      <div className="heat" ref={ref}>
        {weeks.map((w, wi) => (
          <div key={wi} className="heat-col">
            {w.map((d, di) => d ? (
              <button key={di} className={`heat-cell l${level(d.minutes)}`} aria-label={`${new Date(d.day).toDateString()}: ${Math.round(d.minutes)} minutes`}
                onMouseEnter={(e) => { const r = (e.target as HTMLElement).getBoundingClientRect(); const p = ref.current!.getBoundingClientRect(); setTip({ x: r.left - p.left + ref.current!.scrollLeft + 6, y: r.top - p.top, d }) }}
                onMouseLeave={() => setTip(null)} onClick={() => onPick?.(d)} />
            ) : <span key={di} className="heat-cell empty" />)}
          </div>
        ))}
        {tip && <Tip x={tip.x} y={tip.y}>{new Date(tip.d.day).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} · {Math.round(tip.d.minutes)} min</Tip>}
      </div>
      <div className="heat-legend t-caption">Less {[0, 1, 2, 3, 4].map((l) => <span key={l} className={`heat-cell l${l}`} />)} More</div>
    </div>
  )
}

/** Ring gauge for a 0..1 value, with the number as text (never color-alone). */
export function Gauge({ value, label, sub }: { value: number; label: string; sub?: string }) {
  const r = 34
  const C = 2 * Math.PI * r
  return (
    <div className="gauge">
      <svg width={88} height={88} viewBox="0 0 88 88" role="img" aria-label={`${label}: ${Math.round(value * 100)}%`}>
        <circle cx={44} cy={44} r={r} fill="none" stroke="var(--surface-3)" strokeWidth={7} />
        <motion.circle cx={44} cy={44} r={r} fill="none" stroke="var(--accent)" strokeWidth={7} strokeLinecap="round" transform="rotate(-90 44 44)"
          strokeDasharray={C} initial={{ strokeDashoffset: C }} whileInView={{ strokeDashoffset: C * (1 - Math.min(1, Math.max(0, value))) }} viewport={{ once: true }} transition={{ duration: 1.2, ease: [0.32, 0.72, 0, 1] }} />
        <text x={44} y={49} textAnchor="middle" fontSize={17} fontWeight={750} fill="var(--text)">{Math.round(value * 100)}%</text>
      </svg>
      <div><div className="t-headline">{label}</div>{sub && <div className="t-caption">{sub}</div>}</div>
    </div>
  )
}

/** Taste Constellation: artists as stars sized by affinity, co-listening as light threads. Pan + zoom. */
export function Constellation({ nodes, links, onPick }: { nodes: { key: string; name: string; weight: number }[]; links: { a: string; b: string; w: number }[]; onPick?: (name: string) => void }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const [hover, setHover] = useState<string | null>(null)
  const view = useRef({ x: 0, y: 0, k: 1, drag: null as null | { x: number; y: number } })
  const layout = useMemo(() => {
    // Deterministic phyllotaxis layout: the strongest artists sit at the centre.
    const sorted = [...nodes].sort((a, b) => b.weight - a.weight)
    const golden = Math.PI * (3 - Math.sqrt(5))
    return new Map(sorted.map((n, i) => {
      const r = 40 * Math.sqrt(i + 0.5)
      return [n.key, { ...n, x: Math.cos(i * golden) * r, y: Math.sin(i * golden) * r }]
    }))
  }, [nodes])
  useEffect(() => {
    const cv = ref.current
    if (!cv) return
    let raf = 0
    const draw = (t: number) => {
      raf = requestAnimationFrame(draw)
      const dpr = devicePixelRatio || 1
      const w = cv.clientWidth
      const h = cv.clientHeight
      if (cv.width !== w * dpr) { cv.width = w * dpr; cv.height = h * dpr }
      const ctx = cv.getContext('2d')!
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)
      const v = view.current
      const tx = (x: number) => w / 2 + (x + v.x) * v.k
      const ty = (y: number) => h / 2 + (y + v.y) * v.k
      const accent = getComputedStyle(cv).getPropertyValue('--accent').trim() || '#8c7cff'
      const text = getComputedStyle(cv).getPropertyValue('--text').trim() || '#fff'
      for (const l of links) {
        const a = layout.get(l.a)
        const b = layout.get(l.b)
        if (!a || !b) continue
        ctx.strokeStyle = accent
        ctx.globalAlpha = Math.min(0.5, 0.08 + l.w * 0.06) * (hover && (hover === l.a || hover === l.b) ? 2.2 : 1)
        ctx.lineWidth = 1
        ctx.beginPath(); ctx.moveTo(tx(a.x), ty(a.y)); ctx.lineTo(tx(b.x), ty(b.y)); ctx.stroke()
      }
      for (const n of layout.values()) {
        const tw = 0.75 + 0.25 * Math.sin(t / 900 + n.x)
        const r = (3 + n.weight * 9) * Math.sqrt(v.k)
        const x = tx(n.x)
        const y = ty(n.y)
        const g = ctx.createRadialGradient(x, y, 0, x, y, r * 3)
        g.addColorStop(0, accent)
        g.addColorStop(1, 'transparent')
        ctx.globalAlpha = 0.35 * tw
        ctx.fillStyle = g
        ctx.beginPath(); ctx.arc(x, y, r * 3, 0, Math.PI * 2); ctx.fill()
        ctx.globalAlpha = hover === n.key ? 1 : 0.9 * tw
        ctx.fillStyle = '#fff'
        ctx.beginPath(); ctx.arc(x, y, r * 0.55, 0, Math.PI * 2); ctx.fill()
        if (n.weight > 0.25 || hover === n.key || v.k > 1.6) {
          ctx.globalAlpha = hover === n.key ? 1 : 0.75
          ctx.fillStyle = text
          ctx.font = `${hover === n.key ? 650 : 520} 12px Inter, system-ui`
          ctx.textAlign = 'center'
          ctx.fillText(n.name, x, y + r + 14)
        }
      }
      ctx.globalAlpha = 1
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [layout, links, hover])
  const pick = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const cv = ref.current!
    const r = cv.getBoundingClientRect()
    const v = view.current
    const px = (e.clientX - r.left - r.width / 2) / v.k - v.x
    const py = (e.clientY - r.top - r.height / 2) / v.k - v.y
    let best: string | null = null
    let bd = 22 / v.k
    for (const n of layout.values()) { const d = Math.hypot(n.x - px, n.y - py); if (d < bd) { bd = d; best = n.key } }
    return best
  }
  return (
    <canvas
      ref={ref}
      className="constellation"
      onPointerDown={(e) => { view.current.drag = { x: e.clientX, y: e.clientY }; e.currentTarget.setPointerCapture(e.pointerId) }}
      onPointerMove={(e) => {
        const v = view.current
        if (v.drag) { v.x += (e.clientX - v.drag.x) / v.k; v.y += (e.clientY - v.drag.y) / v.k; v.drag = { x: e.clientX, y: e.clientY } }
        else setHover(pick(e))
      }}
      onPointerUp={(e) => { const moved = view.current.drag && (Math.abs(e.clientX - view.current.drag.x) > 3); view.current.drag = null; if (!moved) { const k = pick(e); const n = k && layout.get(k); if (n && onPick) onPick(n.name) } }}
      onWheel={(e) => { const v = view.current; v.k = Math.min(3, Math.max(0.5, v.k * (e.deltaY < 0 ? 1.1 : 0.9))) }}
      aria-label="Taste constellation: your artists as stars"
      role="img"
      style={{ cursor: hover ? 'pointer' : 'grab' }}
    />
  )
}
