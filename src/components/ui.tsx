import { createPortal } from 'react-dom'
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type PointerEvent as RPointerEvent } from 'react'
import { AnimatePresence, motion, useMotionValue, useSpring, useTransform } from 'motion/react'
import { Icon, type IconName } from './Icon'
import { hashHue } from '../lib/color'
import { usePreviewHold } from '../player/usePreviewHold'
import type { Track } from '../lib/types'
import { morphTo } from '../lib/reveal'

export const spring = { type: 'spring', stiffness: 420, damping: 36, mass: 0.9 } as const
export const softSpring = { type: 'spring', stiffness: 260, damping: 30 } as const

/** YouTube 4:3 thumbnails (hq/sd/default) carry letterbox bars; scale them out in square frames. */
export const isLetterboxed = (src?: string | null) => !!src && /\/(hq|sd)?default\.jpg/.test(src) && !/mqdefault/.test(src)

/** Large YouTube artwork: try the bar-free 16:9 renditions first, then the original. */
function candidates(src: string | null | undefined, hi: boolean): string[] {
  if (!src) return []
  const m = /^(https:\/\/i\d?\.ytimg\.com\/vi\/[A-Za-z0-9_-]{11})\/(?:hq|sd)default\.jpg$/.exec(src)
  return hi && m ? [`${m[1]}/maxresdefault.jpg`, `${m[1]}/hq720.jpg`, src] : [src]
}

export function Artwork({ src: original, alt = '', className = '', style, round = false, letterbox, seed, icon = 'note', eager, hi = false }: {
  src?: string | null; alt?: string; className?: string; style?: CSSProperties; round?: boolean; letterbox?: boolean; seed?: string; icon?: IconName; eager?: boolean; hi?: boolean
}) {
  // Derived state keyed by the source (no reset effect: cached images can load before effects run).
  const [st, setSt] = useState({ of: original, attempt: 0, failed: false, loaded: '' })
  if (st.of !== original) setSt({ of: original, attempt: 0, failed: false, loaded: '' })
  const list = candidates(original, hi)
  const attempt = st.of === original ? st.attempt : 0
  const src = list[Math.min(attempt, list.length - 1)]
  const failed = st.of === original && st.failed
  const loaded = st.of === original && !!src && st.loaded === src
  const hue = hashHue(seed ?? original ?? alt)
  const lb = letterbox ?? isLetterboxed(src)
  return (
    <div className={`art ${round ? 'round' : ''} ${className}`} style={{ ['--h' as string]: hue, ...style }}>
      {(!src || failed) && <div className="art-fallback"><Icon name={icon} size={28} /></div>}
      {src && !failed && (
        <img
          src={src}
          alt={alt}
          loading={eager ? 'eager' : 'lazy'}
          decoding="async"
          draggable={false}
          className={`${loaded ? 'in' : ''} ${lb ? 'lb' : ''}`}
          onLoad={(e) => {
            // maxresdefault answers missing renditions with a 120×90 placeholder.
            const img = e.currentTarget
            if (attempt < list.length - 1 && img.naturalWidth <= 120) { setSt((x) => ({ ...x, attempt: x.attempt + 1 })); return }
            setSt((x) => (x.of === original ? { ...x, loaded: src ?? '' } : x))
          }}
          onError={() => setSt((x) => (x.of !== original ? x : attempt < list.length - 1 ? { ...x, attempt: x.attempt + 1 } : { ...x, failed: true }))}
        />
      )}
    </div>
  )
}

/** Cards tilt toward the pointer while hovered/pressed (the app's "tactile covers"). */
export function Tilt({ children, className = '', max = 7, style, innerRef }: { children: ReactNode; className?: string; max?: number; style?: CSSProperties; innerRef?: React.Ref<HTMLDivElement> }) {
  const x = useMotionValue(0)
  const y = useMotionValue(0)
  const rx = useSpring(useTransform(y, [-0.5, 0.5], [max, -max]), { stiffness: 300, damping: 26 })
  const ry = useSpring(useTransform(x, [-0.5, 0.5], [-max, max]), { stiffness: 300, damping: 26 })
  const onMove = (e: RPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'touch') return
    const r = e.currentTarget.getBoundingClientRect()
    x.set((e.clientX - r.left) / r.width - 0.5)
    y.set((e.clientY - r.top) / r.height - 0.5)
  }
  return (
    <motion.div ref={innerRef} className={className} style={{ rotateX: rx, rotateY: ry, transformPerspective: 900, ...style }} onPointerMove={onMove} onPointerLeave={() => { x.set(0); y.set(0) }}>
      {children}
    </motion.div>
  )
}

export function PlayFab({ onClick, playing = false, size = 46, label = 'Play' }: { onClick: (e: React.MouseEvent) => void; playing?: boolean; size?: number; label?: string }) {
  return (
    <motion.button
      className="play-fab"
      aria-label={playing ? 'Pause' : label}
      style={{ width: size, height: size }}
      whileHover={{ scale: 1.08 }}
      whileTap={{ scale: 0.92 }}
      onClick={(e) => { e.stopPropagation(); e.preventDefault(); onClick(e) }}
    >
      <Icon name={playing ? 'pause' : 'play'} size={size * 0.42} style={playing ? undefined : { marginLeft: size * 0.04 }} />
    </motion.button>
  )
}

export function Card({ title, subtitle, art, round, onOpen, onPlay, playing, badge, seed, wide, letterbox, icon, custom, preview }: {
  title: string; subtitle?: ReactNode; art?: string | null; round?: boolean; onOpen?: () => void; onPlay?: () => void; playing?: boolean
  badge?: ReactNode; seed?: string; wide?: boolean; letterbox?: boolean; icon?: IconName; custom?: ReactNode
  /** Hold the cover to hear ~15 s of this song. */
  preview?: Track
}) {
  const hold = usePreviewHold(preview)
  const artRef = useRef<HTMLDivElement>(null)
  // Opening morphs this cover into the next page's hero.
  const open = onOpen ? () => morphTo(artRef.current, onOpen) : undefined
  return (
    <div className={`card ${wide ? 'wide' : ''}`} onClick={hold.guard(open)} role={onOpen ? 'link' : undefined} tabIndex={onOpen ? 0 : -1} onKeyDown={(e) => { if (e.key === 'Enter') open?.() }} {...hold.handlers}>
      <Tilt className="card-art-wrap" innerRef={artRef}>
        {custom ?? <Artwork src={art} round={round} seed={seed ?? title} letterbox={letterbox} icon={icon} className="card-art" />}
        {badge && <div className="card-badge">{badge}</div>}
        {onPlay && <div className="card-fab"><PlayFab onClick={onPlay} playing={playing} size={44} /></div>}
      </Tilt>
      <div className="card-text">
        <div className="card-title ellipsis">{title}</div>
        {subtitle && <div className="card-sub ellipsis">{subtitle}</div>}
      </div>
    </div>
  )
}

export function Shelf({ title, subtitle, action, children, id }: { title?: ReactNode; subtitle?: ReactNode; action?: ReactNode; children: ReactNode; id?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [edges, setEdges] = useState({ left: false, right: false })
  const update = () => {
    const el = ref.current
    if (!el) return
    setEdges({ left: el.scrollLeft > 4, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 4 })
  }
  useLayoutEffect(() => {
    update()
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [children])
  const scroll = (dir: 1 | -1) => ref.current?.scrollBy({ left: dir * ref.current.clientWidth * 0.85, behavior: 'smooth' })
  return (
    <section className="section shelf" id={id}>
      {(title || action) && (
        <div className="section-head">
          <div className="grow">
            {title && <h2>{title}</h2>}
            {subtitle && <div className="t-sub">{subtitle}</div>}
          </div>
          <div className="row" style={{ gap: 6 }}>
            {action}
            <button className="icon-btn sm hover-only" aria-label="Scroll left" disabled={!edges.left} onClick={() => scroll(-1)}><Icon name="chevronLeft" size={18} /></button>
            <button className="icon-btn sm hover-only" aria-label="Scroll right" disabled={!edges.right} onClick={() => scroll(1)}><Icon name="chevronRight" size={18} /></button>
          </div>
        </div>
      )}
      <div className={`shelf-scroll ${edges.left ? 'fade-l' : ''} ${edges.right ? 'fade-r' : ''}`} ref={ref} onScroll={update}>
        {children}
      </div>
    </section>
  )
}

export function Segmented<T extends string>({ value, options, onChange, id, size = 'md' }: { value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void; id: string; size?: 'sm' | 'md' }) {
  return (
    <div className={`segmented ${size}`} role="tablist">
      {options.map((o) => (
        <button key={o.value} role="tab" aria-selected={value === o.value} className={value === o.value ? 'on' : ''} onClick={() => onChange(o.value)}>
          {value === o.value && <motion.span layoutId={`seg-${id}`} className="seg-pill" transition={spring} />}
          <span className="seg-label">{o.label}</span>
        </button>
      ))}
    </div>
  )
}

export function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return <button role="switch" aria-checked={on} aria-label={label} className={`switch ${on ? 'on' : ''}`} onClick={() => onChange(!on)} />
}

export function Sheet({ open, onClose, children, title, width = 520, className = '' }: { open: boolean; onClose: () => void; children: ReactNode; title?: ReactNode; width?: number; className?: string }) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])
  // Portalled to <body>: a page's enter animation (transform / filter) would otherwise trap the
  // fixed overlay inside the page, under the tab bar and mini player.
  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div className="sheet-root" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.22 }} onClick={onClose}>
          <motion.div
            className={`sheet glass-thick ${className}`}
            style={{ maxWidth: width }}
            role="dialog"
            aria-modal="true"
            initial={{ y: 40, scale: 0.96, opacity: 0 }}
            animate={{ y: 0, scale: 1, opacity: 1 }}
            exit={{ y: 30, scale: 0.97, opacity: 0 }}
            transition={spring}
            onClick={(e) => e.stopPropagation()}
          >
            {title ? (
              <div className="sheet-head">
                <div className="t-title">{title}</div>
                <button className="icon-btn sm" aria-label="Close" onClick={onClose}><Icon name="close" size={18} /></button>
              </div>
            ) : (
              // No title: a corner close button, so every sheet can be dismissed by tapping something.
              <button className="icon-btn sm sheet-x" aria-label="Close" onClick={onClose}><Icon name="close" size={16} /></button>
            )}
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}

export function Empty({ icon = 'note', title, body, action }: { icon?: IconName; title: string; body?: ReactNode; action?: ReactNode }) {
  return (
    <motion.div className="empty" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={softSpring}>
      <div className="empty-icon"><Icon name={icon} size={28} /></div>
      <div className="t-title">{title}</div>
      {body && <div className="t-sub" style={{ maxWidth: 420, textAlign: 'center' }}>{body}</div>}
      {action && <div style={{ marginTop: 8 }}>{action}</div>}
    </motion.div>
  )
}

export function Eq({ playing }: { playing: boolean }) {
  return <span className={`eq ${playing ? '' : 'paused'}`} aria-hidden><i /><i /><i /></span>
}

export function SkeletonCards({ n = 6 }: { n?: number }) {
  return (
    <div className="shelf-scroll">
      {Array.from({ length: n }, (_, i) => (
        <div className="card" key={i}>
          <div className="skeleton card-art" style={{ aspectRatio: '1', borderRadius: 14 }} />
          <div className="skeleton" style={{ height: 13, width: '80%', marginTop: 12 }} />
          <div className="skeleton" style={{ height: 11, width: '55%', marginTop: 8 }} />
        </div>
      ))}
    </div>
  )
}

export function SkeletonRows({ n = 8 }: { n?: number }) {
  return (
    <div className="col" style={{ gap: 4 }}>
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="row" style={{ padding: '8px 10px' }}>
          <div className="skeleton" style={{ width: 44, height: 44, borderRadius: 8 }} />
          <div className="grow col" style={{ gap: 7 }}>
            <div className="skeleton" style={{ height: 12, width: `${40 + ((i * 17) % 35)}%` }} />
            <div className="skeleton" style={{ height: 10, width: `${22 + ((i * 11) % 20)}%` }} />
          </div>
        </div>
      ))}
    </div>
  )
}

export function Spinner({ size = 18 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} aria-label="Loading" />
}

/** Large title that fades into a compact sticky header as you scroll (iOS-style). */
export function PageHeader({ title, subtitle, actions, eyebrow }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; eyebrow?: ReactNode }) {
  return (
    <header className="page-header">
      <div className="grow">
        {eyebrow && <div className="t-eyebrow" style={{ marginBottom: 6 }}>{eyebrow}</div>}
        <h1 className="t-large">{title}</h1>
        {subtitle && <div className="t-sub" style={{ marginTop: 6 }}>{subtitle}</div>}
      </div>
      {actions && <div className="row page-header-actions" style={{ gap: 8 }}>{actions}</div>}
    </header>
  )
}

export function Notice({ tone = 'info', icon = 'info', children, action }: { tone?: 'info' | 'warn' | 'error' | 'ai'; icon?: IconName; children: ReactNode; action?: ReactNode }) {
  return (
    <div className={`notice ${tone}`}>
      <Icon name={icon} size={18} />
      <div className="grow">{children}</div>
      {action}
    </div>
  )
}
