/**
 * Animation loops that only run while they can be seen. A canvas or lyric view scrolled out of
 * view, inside a closed panel or `display: none` stops drawing, and starts again when it's back.
 * (Browsers already pause animation frames in background tabs.)
 */
export function loopWhileVisible(el: Element, frame: (t: number) => void): () => void {
  let raf = 0
  const tick = (t: number) => { raf = requestAnimationFrame(tick); frame(t) }
  const start = () => { if (!raf) raf = requestAnimationFrame(tick) }
  const stop = () => { cancelAnimationFrame(raf); raf = 0 }
  if (typeof IntersectionObserver !== 'function') { start(); return stop }
  // Start at once; the observer's first report (right after) stops it if it isn't on screen.
  // Starting optimistically means a missed report can only cost frames, never a frozen view.
  const io = new IntersectionObserver((entries) => { if (entries[entries.length - 1]?.isIntersecting) start(); else stop() })
  io.observe(el)
  start()
  return () => { stop(); io.disconnect() }
}

/**
 * CSS custom properties read at most every `ms` (getComputedStyle every frame forces style work).
 * Theme and artwork colours change rarely; half a second of lag is invisible.
 */
export function cssVars(el: Element, names: string[], ms = 500): () => Record<string, string> {
  let at = -Infinity
  let cached: Record<string, string> = {}
  return () => {
    const now = performance.now()
    if (now - at > ms) {
      const st = getComputedStyle(el)
      cached = Object.fromEntries(names.map((n) => [n, st.getPropertyValue(n).trim()]))
      at = now
    }
    return cached
  }
}
