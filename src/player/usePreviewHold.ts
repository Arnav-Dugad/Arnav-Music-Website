import { useRef } from 'react'
import { endPreview, isPreviewing, startPreview } from './controller'
import { settings } from '../state/settings'
import type { Track } from '../lib/types'

/** Hold a cover to hear ~15 s; release to go back. Returns pointer handlers and a click guard. */
export function usePreviewHold(track: Track | null | undefined) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const held = useRef(false)
  const start = useRef<{ x: number; y: number } | null>(null)
  const clear = () => { if (timer.current) clearTimeout(timer.current); timer.current = null }
  const release = () => {
    clear()
    if (held.current && isPreviewing()) endPreview()
    start.current = null
  }
  if (!track) return { handlers: {}, guard: (fn?: () => void) => fn, held: () => false }
  return {
    handlers: {
      onPointerDown: (e: React.PointerEvent) => {
        if (e.button !== 0 || settings().motion === 'off') return
        held.current = false
        start.current = { x: e.clientX, y: e.clientY }
        clear()
        timer.current = setTimeout(() => { held.current = true; startPreview(track) }, 450)
      },
      onPointerMove: (e: React.PointerEvent) => {
        const s = start.current
        if (s && !held.current && Math.hypot(e.clientX - s.x, e.clientY - s.y) > 8) clear() // scrolling, not holding
      },
      onPointerUp: release,
      onPointerCancel: release,
      onPointerLeave: release,
    },
    /** True while a hold-preview started from this element. */
    held: () => held.current,
    /** Wraps a click handler so the click that ends a hold doesn't also play/open. */
    guard: (fn?: () => void) => (fn ? () => { if (held.current) { held.current = false; return } fn() } : undefined),
  }
}
