/**
 * Spotlight: on a desktop pointer, the card, tile or row under the cursor catches a soft light that
 * follows it (like light raking across glass). One floating layer, moved over whatever is hovered,
 * so no component needs to know about it. It lives inside the scrolling page, so it never covers
 * the sidebar, the player or anything opened on top.
 */
const TARGETS = '.card-art-wrap, .genre-tile, .mood-tile, .track-row, .h-blend, .home-hero, .daylist-art, .set-group, .notice, .np-watch-thumb, [data-spot]'

let started = false
export function startSpotlight() {
  if (started || typeof window === 'undefined') return
  started = true
  if (!matchMedia('(hover: hover) and (pointer: fine)').matches) return
  const layer = document.createElement('div')
  layer.className = 'spotlight'
  layer.setAttribute('aria-hidden', 'true')
  let target: HTMLElement | null = null
  let raf = 0
  let last: PointerEvent | null = null

  const hide = () => {
    target = null
    layer.classList.remove('on')
  }
  const paint = () => {
    raf = 0
    const e = last
    if (!e) return
    const motion = document.documentElement.dataset.motion
    if (motion === 'off') { hide(); return }
    const el = (e.target as Element | null)?.closest?.<HTMLElement>(TARGETS) ?? null
    const scroller = el?.closest<HTMLElement>('.main-scroll')
    if (!el || !scroller) { hide(); return }
    if (layer.parentElement !== scroller) scroller.appendChild(layer)
    const r = el.getBoundingClientRect()
    if (el !== target) {
      target = el
      const cs = getComputedStyle(el)
      layer.style.borderRadius = cs.borderRadius
      layer.dataset.kind = el.matches('.track-row, .set-group, .notice') ? 'soft' : 'bright'
    }
    layer.style.transform = `translate(${r.left}px, ${r.top}px)`
    layer.style.width = `${r.width}px`
    layer.style.height = `${r.height}px`
    layer.style.setProperty('--mx', `${e.clientX - r.left}px`)
    layer.style.setProperty('--my', `${e.clientY - r.top}px`)
    layer.classList.add('on')
  }
  window.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return
    last = e
    if (!raf) raf = requestAnimationFrame(paint)
  }, { passive: true })
  // Scrolling moves things out from under a still pointer: let go until it moves again.
  window.addEventListener('scroll', hide, { passive: true, capture: true })
  document.addEventListener('pointerleave', hide)
  window.addEventListener('blur', hide)
}
