/**
 * Renders a Wrapped month as a vertical story video (720×1280, 30 fps) on a canvas and records it
 * with MediaRecorder — MP4 where the browser supports it, else WebM. Silent: YouTube's audio
 * can't be recorded (and shouldn't be redistributed).
 */
import { artworkFor, barlessThumbs } from './classify'
import { MOODS } from './types'
import { clockLine, type Wrapped } from './wrapped'

const W = 720
const H = 1280
export const SLIDE_MS = [3200, 3600, 4200, 3600, 4000, 3200, 3400, 3200, 4600]

const corsUrl = (u: string | null | undefined) => (u ? (/^https:\/\/(i\d?\.ytimg\.com|yt3\.|lh3\.|is\d-ssl\.mzstatic\.com)/.test(u) ? `/api/img?u=${encodeURIComponent(u)}` : u) : null)

function loadOne(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    // YouTube answers a missing size with a 120×90 grey placeholder: treat that as missing.
    img.onload = () => resolve(img.naturalWidth > 130 ? img : null)
    img.onerror = () => resolve(null)
    img.src = src
  })
}
async function loadImage(url: string | null | undefined): Promise<HTMLImageElement | null> {
  if (!url) return null
  for (const u of barlessThumbs(url)) {
    const img = await loadOne(corsUrl(u)!)
    if (img) return img
  }
  return null
}

const ease = (t: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3)
const fade = (t: number, at = 0, len = 0.25) => ease((t - at) / len)

/** The picture inside any black bars (cinematic videos keep them even in 16:9 thumbnails). */
const boxes = new WeakMap<HTMLImageElement, { x: number; y: number; w: number; h: number }>()
function contentBox(img: HTMLImageElement) {
  const hit = boxes.get(img)
  if (hit) return hit
  let box = { x: 0, y: 0, w: img.width, h: img.height }
  try {
    const c = document.createElement('canvas')
    const sw = 64
    const sh = Math.max(8, Math.round((img.height / img.width) * sw))
    c.width = sw
    c.height = sh
    const g = c.getContext('2d', { willReadFrequently: true })!
    g.drawImage(img, 0, 0, sw, sh)
    const d = g.getImageData(0, 0, sw, sh).data
    const dark = (row: number) => {
      let sum = 0
      for (let i = 0; i < sw; i++) { const o = (row * sw + i) * 4; sum += d[o] + d[o + 1] + d[o + 2] }
      return sum / (sw * 3) < 18
    }
    let top = 0
    while (top < sh / 3 && dark(top)) top++
    let bottom = sh - 1
    while (bottom > (sh * 2) / 3 && dark(bottom)) bottom--
    const k = img.height / sh
    if (top > 0 || bottom < sh - 1) box = { x: 0, y: Math.round(top * k), w: img.width, h: Math.round((bottom - top + 1) * k) }
  } catch { /* tainted canvas: draw as is */ }
  boxes.set(img, box)
  return box
}

/** Source square (x, y, size) of the picture inside any bars. */
function square(img: HTMLImageElement): [number, number, number] {
  const b = contentBox(img)
  const k = Math.min(b.w, b.h)
  return [b.x + (b.w - k) / 2, b.y + (b.h - k) / 2, k]
}

function cover(g: CanvasRenderingContext2D, img: HTMLImageElement | null, x: number, y: number, s: number, r = 28) {
  g.save()
  g.beginPath()
  g.roundRect(x, y, s, s, r)
  g.clip()
  if (img) {
    // Center-crop the picture (inside any black bars) to a square.
    const b = contentBox(img)
    const k = Math.min(b.w, b.h)
    g.drawImage(img, b.x + (b.w - k) / 2, b.y + (b.h - k) / 2, k, k, x, y, s, s)
  } else {
    g.fillStyle = 'rgba(255,255,255,0.12)'
    g.fillRect(x, y, s, s)
  }
  g.restore()
}

function text(g: CanvasRenderingContext2D, s: string, x: number, y: number, size: number, opts: { font?: 'serif' | 'sans'; weight?: number; color?: string; align?: CanvasTextAlign; alpha?: number; max?: number } = {}) {
  g.save()
  g.globalAlpha = opts.alpha ?? 1
  g.fillStyle = opts.color ?? '#fff'
  g.textAlign = opts.align ?? 'left'
  g.font = opts.font === 'serif' ? `${size}px "Instrument Serif", Georgia, serif` : `${opts.weight ?? 700} ${size}px Inter, system-ui, sans-serif`
  let out = s
  if (opts.max) while (g.measureText(out).width > opts.max && out.length > 2) out = out.slice(0, -2)
  if (out !== s) out = `${out.trimEnd()}…`
  g.fillText(out, x, y)
  g.restore()
}

export interface WrappedAssets { songs: (HTMLImageElement | null)[]; artists: (HTMLImageElement | null)[]; album: HTMLImageElement | null }
export async function loadWrappedAssets(w: Wrapped): Promise<WrappedAssets> {
  await Promise.all([document.fonts.load('80px "Instrument Serif"'), document.fonts.load('700 40px Inter')]).catch(() => undefined)
  const [songs, artists, album] = await Promise.all([
    Promise.all(w.songs.map((s) => loadImage(artworkFor(s.track)))),
    Promise.all(w.artists.map((a) => loadImage(a.art))),
    loadImage(w.album?.art),
  ])
  return { songs, artists, album }
}

/** Draws slide [i] at progress [t] (0..1). */
export function drawSlide(g: CanvasRenderingContext2D, w: Wrapped, a: WrappedAssets, i: number, t: number, hue: number) {
  // Background: a slow gradient that turns a little each slide.
  const h1 = (hue + i * 24) % 360
  const grad = g.createLinearGradient(0, 0, W * 0.4, H)
  grad.addColorStop(0, `hsl(${h1}, 62%, 26%)`)
  grad.addColorStop(0.55, `hsl(${(h1 + 40) % 360}, 58%, 14%)`)
  grad.addColorStop(1, '#07070b')
  g.fillStyle = grad
  g.fillRect(0, 0, W, H)
  const glow = g.createRadialGradient(W * 0.75, H * (0.2 + 0.05 * Math.sin(t * 3)), 10, W * 0.75, H * 0.2, W * 0.9)
  glow.addColorStop(0, `hsla(${(h1 + 80) % 360}, 80%, 60%, 0.35)`)
  glow.addColorStop(1, 'transparent')
  g.fillStyle = glow
  g.fillRect(0, 0, W, H)
  const L = 64
  text(g, `ARNAV MUSIC · ${w.label.toUpperCase()}`, L, 110, 22, { weight: 760, alpha: 0.7 * fade(t), color: '#fff' })
  switch (i) {
    case 0: {
      text(g, 'Your', L, 430, 96, { font: 'serif', alpha: fade(t, 0.05) })
      text(g, new Date(w.start).toLocaleDateString(undefined, { month: 'long' }), L, 540, 140, { font: 'serif', alpha: fade(t, 0.12) })
      text(g, 'in music', L, 640, 96, { font: 'serif', alpha: fade(t, 0.2) })
      const n = Math.round(w.minutes * ease((t - 0.3) / 0.5))
      text(g, `${n.toLocaleString()}`, L, 900, 120, { weight: 820, alpha: fade(t, 0.3) })
      text(g, 'minutes of music', L, 960, 34, { weight: 600, alpha: 0.75 * fade(t, 0.35) })
      if (w.change != null) text(g, `${w.change >= 0 ? '+' : ''}${w.change}% vs last month`, L, 1020, 28, { weight: 600, alpha: 0.6 * fade(t, 0.45) })
      break
    }
    case 1: {
      const s = w.songs[0]
      if (!s) break
      const k = 0.9 + 0.1 * ease(t / 0.4)
      const size = 520 * k
      cover(g, a.songs[0], (W - size) / 2, 240 + (520 - size) / 2, size, 36)
      text(g, 'Your song of the month', L, 900, 30, { weight: 650, alpha: 0.75 * fade(t, 0.2) })
      text(g, s.track.title, L, 990, 70, { font: 'serif', alpha: fade(t, 0.28), max: W - L * 2 })
      text(g, s.track.artist, L, 1045, 34, { weight: 600, alpha: 0.8 * fade(t, 0.35), max: W - L * 2 })
      text(g, `Played ${s.plays} ${s.plays === 1 ? 'time' : 'times'}`, L, 1110, 28, { weight: 600, alpha: 0.6 * fade(t, 0.45) })
      break
    }
    case 2: {
      text(g, 'Top songs', L, 260, 92, { font: 'serif', alpha: fade(t) })
      w.songs.forEach((s, j) => {
        const y = 360 + j * 170
        const p = fade(t, 0.1 + j * 0.08)
        g.save(); g.globalAlpha = p; g.translate((1 - p) * 40, 0)
        text(g, String(j + 1), L, y + 92, 52, { weight: 800, alpha: 0.5 })
        cover(g, a.songs[j], L + 70, y, 136, 18)
        text(g, s.track.title, L + 236, y + 62, 38, { weight: 720, max: W - L - 236 - 30 })
        text(g, s.track.artist, L + 236, y + 108, 28, { weight: 560, alpha: 0.7, max: W - L - 236 - 30 })
        g.restore()
      })
      break
    }
    case 3: {
      const ar = w.artists[0]
      if (!ar) break
      const r = 230 * (0.9 + 0.1 * ease(t / 0.4))
      g.save(); g.beginPath(); g.arc(W / 2, 520, r, 0, Math.PI * 2); g.clip()
      const img = a.artists[0]
      if (img) { const [sx, sy, k] = square(img); g.drawImage(img, sx, sy, k, k, W / 2 - r, 520 - r, r * 2, r * 2) } else { g.fillStyle = 'rgba(255,255,255,.12)'; g.fill() }
      g.restore()
      text(g, 'Your top artist', W / 2, 860, 30, { weight: 650, alpha: 0.75 * fade(t, 0.2), align: 'center' })
      text(g, ar.name, W / 2, 960, 84, { font: 'serif', alpha: fade(t, 0.28), align: 'center', max: W - 80 })
      text(g, `${ar.minutes.toLocaleString()} minutes together`, W / 2, 1030, 32, { weight: 600, alpha: 0.75 * fade(t, 0.4), align: 'center' })
      break
    }
    case 4: {
      text(g, 'Top artists', L, 260, 92, { font: 'serif', alpha: fade(t) })
      w.artists.forEach((ar, j) => {
        const y = 380 + j * 160
        const p = fade(t, 0.1 + j * 0.08)
        g.save(); g.globalAlpha = p; g.translate((1 - p) * 40, 0)
        text(g, String(j + 1), L, y + 78, 52, { weight: 800, alpha: 0.5 })
        g.save(); g.beginPath(); g.arc(L + 130, y + 60, 60, 0, Math.PI * 2); g.clip()
        const img = a.artists[j]
        if (img) { const [sx, sy, k] = square(img); g.drawImage(img, sx, sy, k, k, L + 70, y, 120, 120) } else { g.fillStyle = 'rgba(255,255,255,.12)'; g.fill() }
        g.restore()
        text(g, ar.name, L + 220, y + 58, 40, { weight: 720, max: W - L - 220 - 30 })
        text(g, `${ar.minutes.toLocaleString()} min`, L + 220, y + 102, 28, { weight: 560, alpha: 0.7 })
        g.restore()
      })
      break
    }
    case 5: {
      text(g, 'When you listen', L, 260, 80, { font: 'serif', alpha: fade(t) })
      // A 24-hour clock with your peak highlighted.
      const cx = W / 2
      const cy = 640
      for (let hh = 0; hh < 24; hh++) {
        const ang = (hh / 24) * Math.PI * 2 - Math.PI / 2
        const on = hh === w.peakHour
        const len = (on ? 170 : 110) * fade(t, 0.1 + hh * 0.012)
        g.strokeStyle = on ? '#fff' : 'rgba(255,255,255,0.28)'
        g.lineWidth = on ? 14 : 8
        g.lineCap = 'round'
        g.beginPath(); g.moveTo(cx + Math.cos(ang) * 90, cy + Math.sin(ang) * 90); g.lineTo(cx + Math.cos(ang) * (90 + len), cy + Math.sin(ang) * (90 + len)); g.stroke()
      }
      text(g, w.peakHourLabel, cx, cy + 22, 54, { weight: 820, align: 'center', alpha: fade(t, 0.4) })
      text(g, clockLine(w.peakHour), L, 1010, 32, { weight: 600, alpha: 0.85 * fade(t, 0.5), max: W - L * 2 })
      if (w.streak > 1) text(g, `${w.streak} days in a row with music`, L, 1066, 28, { weight: 560, alpha: 0.65 * fade(t, 0.6) })
      break
    }
    case 6: {
      text(g, String(w.newArtists.length), L, 470, 200, { weight: 840, alpha: fade(t) })
      text(g, w.newArtists.length === 1 ? 'new artist found you' : 'new artists found you', L, 545, 40, { weight: 650, alpha: 0.85 * fade(t, 0.15) })
      w.newArtists.slice(0, 6).forEach((n, j) => text(g, n, L, 660 + j * 64, 44, { font: 'serif', alpha: fade(t, 0.25 + j * 0.06), max: W - L * 2 }))
      break
    }
    case 7: {
      const m = MOODS[w.mood]
      g.fillStyle = `hsla(${m.hue}, 80%, 55%, ${0.35 * fade(t)})`
      g.beginPath(); g.arc(W / 2, 560, 280 + 20 * Math.sin(t * Math.PI * 4), 0, Math.PI * 2); g.fill()
      text(g, 'This month felt', W / 2, 520, 40, { weight: 650, align: 'center', alpha: fade(t, 0.1) })
      text(g, m.label, W / 2, 640, 120, { font: 'serif', align: 'center', alpha: fade(t, 0.2) })
      if (w.album) text(g, `On repeat: ${w.album.name}`, W / 2, 1000, 32, { weight: 600, align: 'center', alpha: 0.8 * fade(t, 0.4), max: W - 80 })
      break
    }
    default: {
      text(g, w.label, L, 220, 70, { font: 'serif', alpha: fade(t) })
      const rows: [string, string][] = [
        ['Minutes', w.minutes.toLocaleString()],
        ['Top song', w.songs[0]?.track.title ?? '—'],
        ['Top artist', w.artists[0]?.name ?? '—'],
        ['New artists', String(w.newArtists.length)],
        ['Mood', MOODS[w.mood].label],
        ['Peak hour', w.peakHourLabel || '—'],
      ]
      rows.forEach(([k, v], j) => {
        const y = 340 + j * 130
        text(g, k, L, y, 28, { weight: 600, alpha: 0.6 * fade(t, 0.08 + j * 0.06) })
        text(g, v, L, y + 58, 52, { weight: 780, alpha: fade(t, 0.12 + j * 0.06), max: W - L * 2 })
      })
      cover(g, a.songs[0], W - L - 190, 1010, 190, 24)
      text(g, 'arnav-music · made on your device', L, 1180, 24, { weight: 600, alpha: 0.55 * fade(t, 0.5) })
    }
  }
}

/** Records the whole story. [onProgress] gets 0..1. Resolves with the video file. */
export async function recordWrapped(w: Wrapped, hue: number, onProgress: (p: number) => void): Promise<File> {
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const g = canvas.getContext('2d')
  if (!g || typeof MediaRecorder === 'undefined' || !('captureStream' in canvas)) throw new Error('This browser can’t record video')
  const assets = await loadWrappedAssets(w)
  const mime = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m)) ?? 'video/webm'
  const stream = canvas.captureStream(30)
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6_000_000 })
  const chunks: Blob[] = []
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data) }
  const done = new Promise<void>((r) => { rec.onstop = () => r() })
  const total = SLIDE_MS.reduce((x, y) => x + y, 0)
  drawSlide(g, w, assets, 0, 0, hue)
  rec.start(500)
  const t0 = performance.now()
  await new Promise<void>((resolve) => {
    const frame = () => {
      const el = performance.now() - t0
      if (el >= total) { resolve(); return }
      let acc = 0
      let i = 0
      while (i < SLIDE_MS.length - 1 && el >= acc + SLIDE_MS[i]) { acc += SLIDE_MS[i]; i++ }
      drawSlide(g, w, assets, i, (el - acc) / SLIDE_MS[i], hue)
      onProgress(el / total)
      requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)
  })
  rec.stop()
  await done
  onProgress(1)
  const ext = mime.includes('mp4') ? 'mp4' : 'webm'
  return new File([new Blob(chunks, { type: mime.split(';')[0] })], `arnav-wrapped-${w.key}.${ext}`, { type: mime.split(';')[0] })
}
