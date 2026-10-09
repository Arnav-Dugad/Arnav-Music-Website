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
import { parseHex, proxied } from './color'

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
  document.addEventListener('pointerdown', onPress, { capture: true, passive: true })
}

// ── Touch: glass ripples and stretches under your finger ──

/** Glass controls that react to a press. */
const PRESSABLE = '.tab, .chip, .h-chip, .btn-secondary, .segmented button, .mini, .np-top .icon-btn, .np-controls .icon-btn, .m-account, .h-avatar, .sb-link, .dial-tile, .lg-press, .tp-tab, .tp-search, .glass-card'

function onPress(e: PointerEvent) {
  if (e.button > 0) return
  const root = document.documentElement
  if (root.dataset.motion === 'off' || root.dataset.motion === 'reduced' || matchMedia('(prefers-reduced-motion: reduce)').matches) return
  if (root.dataset.glass === 'off') return
  const el = (e.target as Element | null)?.closest?.(PRESSABLE) as HTMLElement | null
  if (!el || el.matches(':disabled, [aria-disabled="true"]')) return
  const r = el.getBoundingClientRect()
  if (r.width < 8 || r.height < 8) return
  // Stretch: the glass squashes toward your finger and springs back — added on top of any transform it already has.
  const big = r.width * r.height > 40_000
  const sx = big ? 0.015 : 0.06, sy = big ? 0.01 : 0.04
  const ox = ((e.clientX - r.left) / r.width) * 100, oy = ((e.clientY - r.top) / r.height) * 100
  try {
    el.animate(
      [
        { scale: '1 1', transformOrigin: `${ox}% ${oy}%` },
        { scale: `${1 + sx} ${1 - sy}`, transformOrigin: `${ox}% ${oy}%`, offset: 0.35 },
        { scale: `${1 - sx * 0.4} ${1 + sy * 0.5}`, transformOrigin: `${ox}% ${oy}%`, offset: 0.7 },
        { scale: '1 1', transformOrigin: `${ox}% ${oy}%` },
      ],
      { duration: 460, easing: 'cubic-bezier(.3,.7,.3,1)' },
    )
  } catch { /* old browsers: no stretch */ }
  // Ripple: a ring of light spreading through the glass from where you touched.
  const cs = getComputedStyle(el)
  const fx = document.createElement('span')
  fx.className = 'lg-ripple'
  fx.setAttribute('aria-hidden', 'true')
  Object.assign(fx.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`, borderRadius: cs.borderRadius })
  const size = Math.hypot(Math.max(e.clientX - r.left, r.right - e.clientX), Math.max(e.clientY - r.top, r.bottom - e.clientY)) * 2
  const dot = document.createElement('i')
  Object.assign(dot.style, { left: `${e.clientX - r.left - size / 2}px`, top: `${e.clientY - r.top - size / 2}px`, width: `${size}px`, height: `${size}px` })
  fx.appendChild(dot)
  document.body.appendChild(fx)
  const a = dot.animate([{ transform: 'scale(0.05)', opacity: 0.9 }, { transform: 'scale(1)', opacity: 0 }], { duration: 620, easing: 'cubic-bezier(.2,.7,.2,1)' })
  a.onfinish = a.oncancel = () => fx.remove()
  setTimeout(() => fx.remove(), 900)
}

/** Expands a minimised tab bar (tapping it, like iOS). */
export function expandBars() { document.querySelector('.app.mobile')?.classList.remove('bars-min') }

// ── Glass that adapts: strength, style, album colour and how busy the artwork is ──

const busyCache = new Map<string, number>()

/**
 * How visually busy an artwork is, 0 (a flat colour) to 1 (dense detail and contrast): the spread
 * of brightness plus how much it changes from pixel to pixel, on a 32×32 sample.
 */
export function artworkBusyness(url: string | null | undefined): Promise<number> {
  if (!url) return Promise.resolve(0.5)
  const hit = busyCache.get(url)
  if (hit != null) return Promise.resolve(hit)
  return new Promise((resolve) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      try {
        const N = 32
        const c = document.createElement('canvas')
        c.width = N; c.height = N
        const g = c.getContext('2d', { willReadFrequently: true })
        if (!g) return resolve(0.5)
        g.drawImage(img, 0, 0, N, N)
        const d = g.getImageData(0, 0, N, N).data
        const L: number[] = []
        for (let i = 0; i < d.length; i += 4) L.push((0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255)
        const mean = L.reduce((a, b) => a + b, 0) / L.length
        const sd = Math.sqrt(L.reduce((a, b) => a + (b - mean) ** 2, 0) / L.length)
        let edge = 0
        for (let y = 0; y < N - 1; y++) for (let x = 0; x < N - 1; x++) edge += Math.abs(L[y * N + x] - L[y * N + x + 1]) + Math.abs(L[y * N + x] - L[(y + 1) * N + x])
        edge /= (N - 1) * (N - 1) * 2
        const busy = Math.max(0, Math.min(1, sd * 1.8 + edge * 5))
        busyCache.set(url, busy)
        resolve(busy)
      } catch { resolve(0.5) }
    }
    img.onerror = () => resolve(0.5)
    img.src = proxied(url)
  })
}

export interface GlassInput { theme: 'dark' | 'light'; style: 'tinted' | 'clear'; strength: number; adaptive: boolean; busy: number; album: string | null }

const mix = (a: [number, number, number], b: [number, number, number], t: number) => a.map((v, i) => Math.round(v * (1 - t) + b[i] * t)) as [number, number, number]

// The album colour the glass shows right now, and a blend toward the next one.
let shownAlbum: [number, number, number] | null = null
let blendUntil = 0
let blendFrame = 0

/**
 * Called when automix starts blending two songs: the glass tint moves from the old album's colour
 * to the new one over the same time the music crossfades, instead of jumping.
 */
export function glassCrossfade(ms: number) { blendUntil = performance.now() + Math.max(0, ms) }

/** Writes the material variables (src/styles/liquid-glass.css reads them), easing the album tint. */
export function applyGlass(o: GlassInput) {
  const target = o.album ? parseHex(o.album) : null
  cancelAnimationFrame(blendFrame)
  const from = shownAlbum
  const reduce = document.documentElement.dataset.motion === 'off'
  if (!from || !target || reduce || from.every((v, i) => v === target[i])) {
    shownAlbum = target
    writeGlass(o, target)
    return
  }
  // A crossfade in progress sets the length; any other change of song eases over 0.9 s.
  const ms = Math.max(900, blendUntil - performance.now())
  const t0 = performance.now()
  const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2)
  const step = () => {
    const t = Math.min(1, (performance.now() - t0) / ms)
    shownAlbum = mix(from, target, ease(t))
    writeGlass(o, shownAlbum)
    if (t < 1) blendFrame = requestAnimationFrame(step)
  }
  step()
}

function writeGlass(o: GlassInput, album: [number, number, number] | null) {
  const k = Math.max(0, Math.min(1, o.strength / 100))
  // Busy artwork behind → more frost and tint so text stays readable; calm artwork → clearer glass.
  const e = o.adaptive ? Math.max(0, Math.min(1, k + (o.busy - 0.45) * 0.45)) : k
  const dark = o.theme === 'dark'
  const base: [number, number, number] = dark ? [28, 28, 36] : [255, 255, 255]
  const tint = o.style === 'tinted' && album ? mix(base, album, dark ? 0.22 : 0.1) : base
  const clear = o.style === 'clear'
  const a = clear ? (dark ? 0.04 + 0.14 * e : 0.08 + 0.18 * e) : dark ? 0.14 + 0.4 * e : 0.28 + 0.42 * e
  const rgba = (alpha: number) => `rgba(${tint[0]}, ${tint[1]}, ${tint[2]}, ${Math.min(0.94, alpha).toFixed(3)})`
  const r = document.documentElement
  r.style.setProperty('--lg-tint', rgba(a))
  r.style.setProperty('--lg-tint-thick', rgba(a + (clear ? 0.12 : 0.22)))
  r.style.setProperty('--lg-tint-thin', rgba(a * 0.65))
  r.style.setProperty('--lg-b', `${Math.round(clear ? 6 + 12 * e : 12 + 26 * e)}px`)
  r.style.setProperty('--lg-sat', (clear ? 1.5 + 0.3 * e : 1.6 + 0.5 * e).toFixed(2))
  r.style.setProperty('--lg-bright', (clear ? (dark ? 1.14 : 1.06) : dark ? 1.04 + 0.04 * (1 - e) : 1.03).toFixed(3))
  r.dataset.glassStyle = o.style
}
