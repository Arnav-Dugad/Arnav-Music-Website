import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Icon } from '../components/Icon'
import { Empty, Segmented } from '../components/ui'
import { useLibrary, liveEvents, visiblePlaylists } from '../state/library'
import { trackRegistry } from '../state/tracks'
import { artworkFor, barlessThumbs } from '../lib/classify'
import { extractPalette } from '../lib/color'
import type { Track } from '../lib/types'

interface Tile { key: string; title: string; sub: string; art: string; href: string }
interface Pos { x: number; y: number; z: number; r: number }

const PER_LAYER = 9
const DEPTH = 720
const PERSPECTIVE = 1100
const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t) }

/** Colour families for constellations (hue ranges), named for the label. */
const FAMILIES = [
  { name: 'Reds', from: 345, to: 15 }, { name: 'Ambers', from: 15, to: 45 }, { name: 'Golds', from: 45, to: 70 }, { name: 'Greens', from: 70, to: 165 },
  { name: 'Teals', from: 165, to: 200 }, { name: 'Blues', from: 200, to: 250 }, { name: 'Violets', from: 250, to: 290 }, { name: 'Pinks', from: 290, to: 345 },
]
const familyOf = (h: number) => Math.max(0, FAMILIES.findIndex((f) => (f.from < f.to ? h >= f.from && h < f.to : h >= f.from || h < f.to)))

function hexHue(hex: string): { h: number; s: number; l: number } {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex)
  if (!m) return { h: 0, s: 0, l: 0.5 }
  const n = parseInt(m[1], 16)
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2
  if (max === min) return { h: 0, s: 0, l }
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return { h: h * 60, s, l }
}

/** Covers you've lived with: albums and films you played, your playlists, then liked songs. */
function useTiles(): Tile[] {
  const events = useLibrary((s) => s.events)
  const playlists = useLibrary((s) => s.playlists)
  const likes = useLibrary((s) => s.likes)
  return useMemo(() => {
    const out: Tile[] = []
    const seen = new Set<string>()
    const albums = new Map<string, { t: Track; n: number }>()
    for (const e of liveEvents(events)) {
      const t = trackRegistry.get(e.trackId)
      if (!t?.album) continue
      const k = t.album.toLowerCase()
      albums.set(k, { t: albums.get(k)?.t ?? t, n: (albums.get(k)?.n ?? 0) + 1 })
    }
    for (const { t } of [...albums.values()].sort((a, b) => b.n - a.n)) {
      out.push({ key: `al:${t.album}`, title: t.album!, sub: t.artist, art: artworkFor(t), href: `/album/${encodeURIComponent(t.album!)}?a=${encodeURIComponent(t.artist)}` })
      seen.add(t.album!.toLowerCase())
    }
    for (const p of visiblePlaylists(playlists)) {
      const first = trackRegistry.many(p.trackIds.slice(0, 1))[0]
      if (first) out.push({ key: `pl:${p.id}`, title: p.name, sub: `${p.trackIds.length} songs`, art: artworkFor(first), href: `/playlist/${p.id}` })
    }
    for (const t of trackRegistry.many(Object.keys(likes)).slice(0, 80)) {
      if (t.album && seen.has(t.album.toLowerCase())) continue
      out.push({ key: `t:${t.id}`, title: t.title, sub: t.artist, art: artworkFor(t), href: `/credits/${encodeURIComponent(t.id)}` })
    }
    return out.slice(0, 150)
  }, [events, playlists, likes])
}

/** A 3D wall of covers you fly through; switch to constellations to see them gather by colour. */
export default function WallPage() {
  const nav = useNavigate()
  const tiles = useTiles()
  const [mode, setMode] = useState<'wall' | 'stars'>('wall')
  const [colors, setColors] = useState<Map<string, { hex: string; h: number; s: number }>>(new Map())
  const world = useRef<HTMLDivElement>(null)
  const lines = useRef<HTMLCanvasElement>(null)
  const tileRefs = useRef<(HTMLButtonElement | null)[]>([])
  const cam = useRef({ z: 0, target: 0, rx: 0, ry: 0, tx: 0, ty: 0 })
  const live = useRef<Pos[]>([])
  const spread = typeof window !== 'undefined' ? Math.max(0.5, Math.min(1, window.innerWidth / 1000)) : 1

  // Each cover's most vivid colour (only needed for constellations; loaded gently).
  useEffect(() => {
    if (mode !== 'stars') return
    let alive = true
    const todo = tiles.filter((t) => !colors.has(t.key))
    let i = 0
    const next = async (): Promise<void> => {
      const t = todo[i++]
      if (!t || !alive) return
      const p = await extractPalette(barlessThumbs(t.art)[1] ?? t.art).catch(() => null)
      if (p && alive) { const c = hexHue(p.vivid); setColors((m) => new Map(m).set(t.key, { hex: p.vivid, h: c.h, s: c.s })) }
      return next()
    }
    void Promise.all([next(), next(), next(), next(), next(), next()])
    return () => { alive = false }
  }, [mode, tiles]) // eslint-disable-line react-hooks/exhaustive-deps

  const wallPlace = useMemo<Pos[]>(() => tiles.map((_, i) => {
    const layer = Math.floor(i / PER_LAYER)
    const j = i % PER_LAYER
    const col = (j % 3) - 1
    const row = Math.floor(j / 3) - 1
    const jx = Math.sin(i * 12.9898) * 60
    const jy = Math.cos(i * 78.233) * 40
    return { x: (col * 360 + jx + (layer % 2 ? 180 : 0) * (col === 1 ? -1 : 1) * 0.3) * spread, y: (row * 300 + jy) * spread, z: -layer * DEPTH - (j % 2) * 120, r: Math.sin(i * 3.1) * 6 }
  }), [tiles, spread])

  // Constellations: one cluster per colour family, spread around a ring through space.
  const clusters = useMemo(() => {
    const groups = new Map<number, number[]>()
    tiles.forEach((t, i) => {
      const c = colors.get(t.key)
      const f = c && c.s > 0.12 ? familyOf(c.h) : -1
      if (f < 0) return
      groups.set(f, [...(groups.get(f) ?? []), i])
    })
    return [...groups.entries()].sort((a, b) => a[0] - b[0])
  }, [tiles, colors])
  const starPlace = useMemo<Pos[]>(() => {
    const out = wallPlace.map((p) => ({ ...p, z: p.z - 2600 })) // not yet coloured: drift far back
    const k = Math.max(1, clusters.length)
    clusters.forEach(([, members], ci) => {
      const ang = (ci / k) * Math.PI * 2 - Math.PI / 2
      const cx = Math.cos(ang) * 760 * spread
      const cy = Math.sin(ang) * 380 * spread
      const cz = -900 - ci * 520
      members.forEach((ti, j) => {
        const a = j * 2.39996 // golden angle spiral
        const rr = 80 + Math.sqrt(j) * 115
        out[ti] = { x: cx + Math.cos(a) * rr * spread, y: cy + Math.sin(a) * rr * 0.75 * spread, z: cz - (j % 3) * 90, r: 0 }
      })
    })
    return out
  }, [wallPlace, clusters, spread])
  const target = mode === 'stars' ? starPlace : wallPlace
  const layers = Math.ceil(tiles.length / PER_LAYER)
  const maxZ = mode === 'stars' ? Math.max(0, clusters.length * 520 + 400) : Math.max(0, (layers - 1) * DEPTH + 300)

  const targetRef = useRef(target)
  targetRef.current = target
  const clustersRef = useRef(clusters)
  clustersRef.current = clusters
  const colorsRef = useRef(colors)
  colorsRef.current = colors
  const modeRef = useRef(mode)
  modeRef.current = mode

  useEffect(() => {
    if (!live.current.length || live.current.length !== tiles.length) live.current = wallPlace.map((p) => ({ ...p }))
    let raf = 0
    const c = cam.current
    const frame = () => {
      raf = requestAnimationFrame(frame)
      c.z += (c.target - c.z) * 0.09
      c.rx += (c.tx - c.rx) * 0.06
      c.ry += (c.ty - c.ry) * 0.06
      if (world.current) world.current.style.transform = `translateZ(${c.z}px) rotateX(${c.rx}deg) rotateY(${c.ry}deg)`
      const tgt = targetRef.current
      const pos = live.current
      tgt.forEach((t, i) => {
        const p = pos[i]
        if (!p) return
        // Drift towards the target with a soft, staggered spring.
        const k = 0.035 + (i % 7) * 0.004
        p.x += (t.x - p.x) * k; p.y += (t.y - p.y) * k; p.z += (t.z - p.z) * k; p.r += (t.r - p.r) * k
        const el = tileRefs.current[i]
        if (!el) return
        el.style.transform = `translate3d(${p.x}px, ${p.y}px, ${p.z}px) rotate(${p.r}deg)`
        const rel = p.z + c.z
        const o = smooth(-5600, -3400, rel) * (1 - smooth(-60, 380, rel))
        el.style.opacity = String(o)
        el.style.pointerEvents = o > 0.4 && rel < -100 ? 'auto' : 'none'
        el.style.visibility = o < 0.01 ? 'hidden' : 'visible'
      })
      // Constellation lines: project each tile's centre the way CSS does, then draw.
      const cv = lines.current
      const g = cv?.getContext('2d')
      if (!cv || !g) return
      const dpr = Math.min(2, devicePixelRatio || 1)
      if (cv.width !== Math.round(innerWidth * dpr)) { cv.width = Math.round(innerWidth * dpr); cv.height = Math.round(innerHeight * dpr) }
      g.setTransform(dpr, 0, 0, dpr, 0, 0)
      g.clearRect(0, 0, innerWidth, innerHeight)
      if (modeRef.current !== 'stars') return
      const ox = innerWidth / 2
      const oy = innerHeight * 0.46
      const ry = (c.ry * Math.PI) / 180
      const rx = (c.rx * Math.PI) / 180
      const project = (p: Pos) => {
        // rotateY, then rotateX, then translateZ (CSS applies the rightmost transform first).
        const x1 = p.x * Math.cos(ry) + p.z * Math.sin(ry)
        const z1 = -p.x * Math.sin(ry) + p.z * Math.cos(ry)
        const y2 = p.y * Math.cos(rx) - z1 * Math.sin(rx)
        const z2 = p.y * Math.sin(rx) + z1 * Math.cos(rx) + c.z
        const k = PERSPECTIVE / (PERSPECTIVE - z2)
        return { x: ox + x1 * k, y: oy + y2 * k, z: z2, ok: z2 < PERSPECTIVE - 50 }
      }
      for (const [fam, members] of clustersRef.current) {
        const pts = members.map((i) => project(pos[i]))
        const hex = colorsRef.current.get(tiles[members[0]]?.key)?.hex ?? '#ffffff'
        g.strokeStyle = hex
        g.lineWidth = 1.2
        for (let j = 1; j < pts.length; j++) {
          const a = pts[j - 1]
          const b = pts[j]
          if (!a.ok || !b.ok) continue
          const fadeIn = smooth(-5600, -3400, Math.min(a.z, b.z)) * (1 - smooth(-60, 380, Math.max(a.z, b.z)))
          g.globalAlpha = 0.55 * fadeIn
          g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke()
        }
        // The family's name near its brightest star.
        const lead = pts[0]
        if (lead?.ok) {
          g.globalAlpha = 0.85 * smooth(-5600, -3400, lead.z) * (1 - smooth(-60, 380, lead.z))
          g.fillStyle = hex
          g.font = '700 13px Inter, system-ui, sans-serif'
          g.shadowColor = 'rgba(0,0,0,0.85)'
          g.shadowBlur = 8
          g.fillText(`${FAMILIES[fam].name} · ${members.length}`, lead.x + 14, lead.y - 18)
          g.shadowBlur = 0
        }
      }
      g.globalAlpha = 1
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [tiles, wallPlace])

  useEffect(() => {
    const c = cam.current
    c.target = Math.min(c.target, maxZ)
    const clamp = (v: number) => Math.max(0, Math.min(maxZ, v))
    const onWheel = (e: WheelEvent) => { e.preventDefault(); c.target = clamp(c.target + e.deltaY * 1.4) }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowUp' || e.key === 'ArrowRight' || e.key === ' ') c.target = clamp(c.target + DEPTH)
      if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') c.target = clamp(c.target - DEPTH)
      if (e.key === 'Escape') nav(-1)
    }
    const onMove = (e: PointerEvent) => { c.ty = ((e.clientX / innerWidth) - 0.5) * 14; c.tx = -((e.clientY / innerHeight) - 0.5) * 10 }
    let dragY: number | null = null
    const onDown = (e: PointerEvent) => { if ((e.target as HTMLElement).closest('.wall-hud')) return; dragY = e.clientY }
    const onDrag = (e: PointerEvent) => { if (dragY != null) { c.target = clamp(c.target + (dragY - e.clientY) * 4); dragY = e.clientY } }
    const onUp = () => { dragY = null }
    addEventListener('wheel', onWheel, { passive: false })
    addEventListener('keydown', onKey)
    addEventListener('pointermove', onMove)
    addEventListener('pointerdown', onDown)
    addEventListener('pointermove', onDrag)
    addEventListener('pointerup', onUp)
    return () => {
      removeEventListener('wheel', onWheel)
      removeEventListener('keydown', onKey)
      removeEventListener('pointermove', onMove)
      removeEventListener('pointerdown', onDown)
      removeEventListener('pointermove', onDrag)
      removeEventListener('pointerup', onUp)
    }
  }, [maxZ, nav])

  if (tiles.length < 6) {
    return <div className="page"><Empty icon="wall" title="Your wall fills as you listen" body="Play albums and make playlists — their covers appear here as a wall you can fly through." action={<button className="btn btn-primary" onClick={() => nav('/explore')}>Explore music</button>} /></div>
  }
  const coloured = tiles.filter((t) => colors.has(t.key)).length
  return (
    <div className={`wall ${mode}`} aria-label="Album wall">
      <div className="wall-hud">
        <button className="icon-btn" aria-label="Close" onClick={() => nav(-1)}><Icon name="close" size={20} /></button>
        <div className="grow"><div className="t-title">Album wall</div><div className="t-caption">{mode === 'stars' && coloured < tiles.length ? `Gathering by colour… ${coloured}/${tiles.length}` : `${tiles.length} covers · scroll or drag to fly · tap to open`}</div></div>
        <Segmented id="wall-mode" size="sm" value={mode} onChange={(m) => { setMode(m); cam.current.target = 0 }} options={[{ value: 'wall', label: 'Wall' }, { value: 'stars', label: 'Constellations' }]} />
      </div>
      <div className="wall-scene">
        <div className="wall-world" ref={world}>
          {tiles.map((t, i) => (
            <button key={t.key} ref={(el) => { tileRefs.current[i] = el }} className="wall-tile" onClick={() => nav(t.href)} aria-label={`${t.title} — ${t.sub}`}
              style={mode === 'stars' && colors.get(t.key) ? { ['--glow' as string]: colors.get(t.key)!.hex } : undefined}>
              <img src={barlessThumbs(t.art)[0]} alt="" loading="lazy" draggable={false} onError={(e) => { const next = barlessThumbs(t.art)[1]; if (next && e.currentTarget.src !== next) e.currentTarget.src = next }}
                onLoad={(e) => { if (e.currentTarget.naturalWidth <= 120) (e.currentTarget.closest('.wall-tile') as HTMLElement | null)?.style.setProperty('display', 'none') }} />
              <span className="wall-cap"><b>{t.title}</b><i>{t.sub}</i></span>
            </button>
          ))}
        </div>
      </div>
      <canvas ref={lines} className="wall-lines" aria-hidden />
    </div>
  )
}
