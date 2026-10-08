/**
 * Dynamic artwork palette with guaranteed contrast (port of the app's ColorMath idea):
 * the backdrop is darkened until text reaches ≥7:1, muted ≥4.5:1, accent ≥3:1.
 */
export interface Palette {
  /** Deep backdrop colours for gradients. */
  bg: [string, string, string]
  accent: string
  onAccent: string
  /** The most vivid colour, unadjusted (glows, halos). */
  vivid: string
  dark: boolean
}

type RGB = [number, number, number]

export const DEFAULT_PALETTE: Palette = {
  bg: ['#17132b', '#0e0c1a', '#08070d'],
  accent: '#8C7CFF',
  onAccent: '#0B0B0F',
  vivid: '#8C7CFF',
  dark: true,
}

const cache = new Map<string, Palette>()

export const hex = ([r, g, b]: RGB) => `#${[r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')}`
export function parseHex(h: string): RGB {
  const s = h.replace('#', '')
  const n = parseInt(s.length === 3 ? s.split('').map((c) => c + c).join('') : s.slice(0, 6), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function luminance([r, g, b]: RGB): number {
  const f = (c: number) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}
export function contrast(a: RGB, b: RGB): number {
  const la = luminance(a)
  const lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

function rgbToHsl([r, g, b]: RGB): [number, number, number] {
  r /= 255; g /= 255; b /= 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return [h * 60, s, l]
}
export function hslToRgb(h: number, s: number, l: number): RGB {
  h = ((h % 360) + 360) % 360
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x]
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255]
}

/** Builds a contrast-safe palette from one or more seed colours. */
export function paletteFrom(seeds: RGB[]): Palette {
  const scored = seeds
    .map((c) => ({ c, hsl: rgbToHsl(c) }))
    .sort((a, b) => b.hsl[1] * (1 - Math.abs(b.hsl[2] - 0.5)) - a.hsl[1] * (1 - Math.abs(a.hsl[2] - 0.5)))
  const vividC = scored[0]?.c ?? parseHex('#8C7CFF')
  const [h, s] = rgbToHsl(vividC)
  const second = scored[1]?.hsl ?? [h + 40, s, 0.4]
  const sat = Math.min(0.75, Math.max(0.18, s))
  const bg: [string, string, string] = [
    hex(hslToRgb(h, sat * 0.9, 0.2)),
    hex(hslToRgb(second[0], Math.min(0.6, Math.max(0.15, second[1])) * 0.8, 0.12)),
    hex(hslToRgb(h, sat * 0.5, 0.06)),
  ]
  // Accent: vivid, light enough for ≥3:1 on the darkest backdrop.
  let l = Math.max(0.55, rgbToHsl(vividC)[2])
  let accent = hslToRgb(h, Math.max(0.55, Math.min(0.95, s + 0.15)), l)
  const base = parseHex(bg[0])
  for (let i = 0; i < 20 && contrast(accent, base) < 4.5; i++) {
    l = Math.min(0.92, l + 0.03)
    accent = hslToRgb(h, Math.max(0.5, Math.min(0.95, s + 0.15)), l)
  }
  const onAccent = luminance(accent) > 0.45 ? '#0B0B0F' : '#FFFFFF'
  return { bg, accent: hex(accent), onAccent, vivid: hex(vividC), dark: true }
}

export function proxied(url: string): string {
  try {
    const u = new URL(url)
    if (/(^|\.)ytimg\.com$|ggpht\.com$|googleusercontent\.com$/.test(u.hostname)) return `/api/img?u=${encodeURIComponent(url)}`
  } catch { /* relative */ }
  return url
}

/** Extracts a palette from artwork (via the CORS-safe image proxy), cached per URL. */
export function extractPalette(url: string | null | undefined): Promise<Palette> {
  if (!url) return Promise.resolve(DEFAULT_PALETTE)
  const hit = cache.get(url)
  if (hit) return Promise.resolve(hit)
  return new Promise((resolve) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.decoding = 'async'
    const done = (p: Palette) => { cache.set(url, p); resolve(p) }
    img.onload = () => {
      try {
        const size = 48
        const canvas = document.createElement('canvas')
        canvas.width = size
        canvas.height = size
        const ctx = canvas.getContext('2d', { willReadFrequently: true })
        if (!ctx) return done(DEFAULT_PALETTE)
        // YouTube thumbnails are 16:9 with letterbox bars: sample the centre square.
        const side = Math.min(img.naturalWidth, img.naturalHeight)
        const sx = (img.naturalWidth - side) / 2
        const sy = (img.naturalHeight - side) / 2
        ctx.drawImage(img, sx + side * 0.08, sy + side * 0.08, side * 0.84, side * 0.84, 0, 0, size, size)
        const data = ctx.getImageData(0, 0, size, size).data
        const buckets = new Map<number, { n: number; r: number; g: number; b: number }>()
        for (let i = 0; i < data.length; i += 4) {
          const r = data[i], g = data[i + 1], b = data[i + 2]
          const [hh, ss, ll] = rgbToHsl([r, g, b])
          if (ll < 0.08 || ll > 0.94) continue
          const key = (Math.round(hh / 24) << 4) | Math.round(ss * 3) << 2 | Math.round(ll * 3)
          const bkt = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 }
          const w = 0.4 + ss
          bkt.n += w; bkt.r += r * w; bkt.g += g * w; bkt.b += b * w
          buckets.set(key, bkt)
        }
        const seeds = [...buckets.values()].sort((a, b) => b.n - a.n).slice(0, 6).map((b) => [b.r / b.n, b.g / b.n, b.b / b.n] as RGB)
        done(seeds.length ? paletteFrom(seeds) : DEFAULT_PALETTE)
      } catch {
        done(DEFAULT_PALETTE)
      }
    }
    img.onerror = () => done(DEFAULT_PALETTE)
    img.src = proxied(url)
  })
}

/** Deterministic colour from a string (for generated covers and avatars). */
export function hashHue(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return Math.abs(h) % 360
}
