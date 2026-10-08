import { useEffect, useMemo, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { Icon } from '../components/Icon'
import { Empty } from '../components/ui'
import { useLibrary, liveEvents, visiblePlaylists } from '../state/library'
import { trackRegistry } from '../state/tracks'
import { artworkFor, barlessThumbs } from '../lib/classify'
import type { Track } from '../lib/types'

interface Tile { key: string; title: string; sub: string; art: string; href: string }

const PER_LAYER = 9
const DEPTH = 720
const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t) }

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
    return out.slice(0, 180)
  }, [events, playlists, likes])
}

/** A 3D wall of covers you fly through (scroll, drag or arrow keys); the mouse tilts the view. */
export default function WallPage() {
  const nav = useNavigate()
  const tiles = useTiles()
  const world = useRef<HTMLDivElement>(null)
  const tileRefs = useRef<(HTMLButtonElement | null)[]>([])
  const cam = useRef({ z: 0, target: 0, rx: 0, ry: 0, tx: 0, ty: 0 })
  const layers = Math.ceil(tiles.length / PER_LAYER)
  const maxZ = Math.max(0, (layers - 1) * DEPTH + 300)

  // Fixed, pleasing positions: a 3×3 grid per layer, nudged so layers don't line up.
  const spread = typeof window !== 'undefined' ? Math.max(0.5, Math.min(1, window.innerWidth / 1000)) : 1
  const place = useMemo(() => tiles.map((_, i) => {
    const layer = Math.floor(i / PER_LAYER)
    const j = i % PER_LAYER
    const col = (j % 3) - 1
    const row = Math.floor(j / 3) - 1
    const jx = Math.sin(i * 12.9898) * 60
    const jy = Math.cos(i * 78.233) * 40
    return { x: (col * 360 + jx + (layer % 2 ? 180 : 0) * (col === 1 ? -1 : 1) * 0.3) * spread, y: (row * 300 + jy) * spread, z: -layer * DEPTH - (j % 2) * 120, r: Math.sin(i * 3.1) * 6 }
  }), [tiles, spread])

  useEffect(() => {
    let raf = 0
    const c = cam.current
    const frame = () => {
      raf = requestAnimationFrame(frame)
      c.z += (c.target - c.z) * 0.09
      c.rx += (c.tx - c.rx) * 0.06
      c.ry += (c.ty - c.ry) * 0.06
      if (world.current) world.current.style.transform = `translateZ(${c.z}px) rotateX(${c.rx}deg) rotateY(${c.ry}deg)`
      place.forEach((p, i) => {
        const el = tileRefs.current[i]
        if (!el) return
        const rel = p.z + c.z // < 0: ahead of the camera
        const o = smooth(-5200, -3200, rel) * (1 - smooth(-60, 380, rel))
        el.style.opacity = String(o)
        el.style.pointerEvents = o > 0.4 && rel < -100 ? 'auto' : 'none'
        el.style.visibility = o < 0.01 ? 'hidden' : 'visible'
      })
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [place])

  useEffect(() => {
    const c = cam.current
    const clamp = (v: number) => Math.max(0, Math.min(maxZ, v))
    const onWheel = (e: WheelEvent) => { e.preventDefault(); c.target = clamp(c.target + e.deltaY * 1.4) }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowUp' || e.key === 'ArrowRight' || e.key === ' ') c.target = clamp(c.target + DEPTH)
      if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') c.target = clamp(c.target - DEPTH)
      if (e.key === 'Escape') nav(-1)
    }
    const onMove = (e: PointerEvent) => { c.ty = ((e.clientX / innerWidth) - 0.5) * 14; c.tx = -((e.clientY / innerHeight) - 0.5) * 10 }
    let dragY: number | null = null
    const onDown = (e: PointerEvent) => { dragY = e.clientY }
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
  return (
    <div className="wall" aria-label="Album wall">
      <div className="wall-hud">
        <button className="icon-btn" aria-label="Close" onClick={() => nav(-1)}><Icon name="close" size={20} /></button>
        <div><div className="t-title">Album wall</div><div className="t-caption">{tiles.length} covers · scroll or drag to fly · tap to open</div></div>
      </div>
      <div className="wall-scene">
        <div className="wall-world" ref={world}>
          {tiles.map((t, i) => {
            const p = place[i]
            return (
              <button key={t.key} ref={(el) => { tileRefs.current[i] = el }} className="wall-tile" style={{ transform: `translate3d(${p.x}px, ${p.y}px, ${p.z}px) rotate(${p.r}deg)` }} onClick={() => nav(t.href)} aria-label={`${t.title} — ${t.sub}`}>
                <img src={barlessThumbs(t.art)[0]} alt="" loading="lazy" draggable={false} onError={(e) => { const next = barlessThumbs(t.art)[1]; if (next && e.currentTarget.src !== next) e.currentTarget.src = next }} />
                <span className="wall-cap"><b>{t.title}</b><i>{t.sub}</i></span>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
