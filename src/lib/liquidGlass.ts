/**
 * Liquid Glass, like Apple's iOS / iPadOS 26 material.
 *
 * CSS gives every glass surface its frost (blur + saturation + brightness), sheen, specular rim and
 * depth (src/styles/liquid-glass.css). This adds the part CSS can't: real refraction at the edges —
 * an SVG displacement filter used inside `backdrop-filter`, so content bends as it slides under a
 * floating control. Only Chromium renders SVG filters there (Chrome, Edge, Samsung Internet); other
 * browsers keep the frosted material. It also drives the iOS 26 tab bar: it shrinks to the current
 * tab while you scroll down (the mini player moves up beside it) and expands when you scroll up.
 */

/** A lens-like displacement map: pixels near an edge are pulled inward, the middle is untouched. */
function displacementMap(): string {
  const W = 256, H = 256
  const c = document.createElement('canvas')
  c.width = W; c.height = H
  const ctx = c.getContext('2d')
  if (!ctx) return ''
  const img = ctx.createImageData(W, H)
  // Edge bands as a share of the box: floating controls are wide and short, so the vertical band is deeper.
  const ex = 0.1, ey = 0.32
  const ease = (t: number) => t * t * (3 - 2 * t)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const u = (x + 0.5) / W, v = (y + 0.5) / H
      const dx = u < ex ? ease(1 - u / ex) : u > 1 - ex ? -ease(1 - (1 - u) / ex) : 0
      const dy = v < ey ? ease(1 - v / ey) : v > 1 - ey ? -ease(1 - (1 - v) / ey) : 0
      const i = (y * W + x) * 4
      img.data[i] = Math.round(128 + dx * 127)
      img.data[i + 1] = Math.round(128 + dy * 127)
      img.data[i + 2] = 128
      img.data[i + 3] = 255
    }
  }
  ctx.putImageData(img, 0, 0)
  return c.toDataURL('image/png')
}

function supportsRefraction(): boolean {
  const ua = navigator.userAgent
  // iOS browsers are all WebKit (CriOS / EdgiOS / FxiOS), which ignores SVG backdrop filters.
  if (!/Chrome\/|Chromium\/|Edg\//.test(ua) || /CriOS|EdgiOS|FxiOS|Firefox\//.test(ua)) return false
  try { return CSS.supports('backdrop-filter', 'url(#a) blur(2px)') } catch { return false }
}

export function installLiquidGlass() {
  const root = document.documentElement
  if (supportsRefraction()) {
    const map = displacementMap()
    if (map) {
      const ns = 'http://www.w3.org/2000/svg'
      const svg = document.createElementNS(ns, 'svg')
      svg.setAttribute('aria-hidden', 'true')
      svg.setAttribute('width', '0')
      svg.setAttribute('height', '0')
      svg.style.position = 'absolute'
      svg.innerHTML = `<filter id="lg-refract" x="0" y="0" width="1" height="1" filterUnits="objectBoundingBox" primitiveUnits="objectBoundingBox" color-interpolation-filters="sRGB">
        <feImage href="${map}" x="0" y="0" width="1" height="1" preserveAspectRatio="none" result="map" />
        <feDisplacementMap in="SourceGraphic" in2="map" scale="0.07" xChannelSelector="R" yChannelSelector="G" />
      </filter>`
      document.body.appendChild(svg)
      root.classList.add('lg-refract')
    }
  }
  // Phones: the tab bar minimises while you scroll down through a page, like Apple Music.
  let last = 0
  let acc = 0
  const onScroll = (e: Event) => {
    const el = e.target as HTMLElement
    if (!el.classList?.contains('main-scroll')) return
    const y = el.scrollTop
    const d = y - last
    last = y
    acc = Math.sign(d) === Math.sign(acc) ? acc + d : d
    const app = document.querySelector('.app.mobile')
    if (!app) return
    if (y < 40) app.classList.remove('bars-min')
    else if (acc > 36) app.classList.add('bars-min')
    else if (acc < -28) app.classList.remove('bars-min')
  }
  document.addEventListener('scroll', onScroll, { capture: true, passive: true })
}

/** Expands a minimised tab bar (tapping it, like iOS). */
export function expandBars() { document.querySelector('.app.mobile')?.classList.remove('bars-min') }
