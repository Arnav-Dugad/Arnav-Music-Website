import { proxied } from './color'
import type { Track } from './types'

const W = 1080
const H = 1350

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('image'))
    img.src = proxied(src)
  })
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number): string[] {
  const words = text.split(/\s+/)
  const lines: string[] = []
  let line = ''
  for (const w of words) {
    const test = line ? `${line} ${w}` : w
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line)
      line = w
      if (lines.length === maxLines) break
    } else line = test
  }
  if (lines.length < maxLines && line) lines.push(line)
  if (lines.length === maxLines && words.join(' ') !== lines.join(' ')) lines[maxLines - 1] = lines[maxLines - 1].replace(/\s*\S*$/, '…')
  return lines
}

/** Renders a 1080×1350 share card on the device: blurred cover, artwork, title, artist and a lyric. */
export async function renderShareCard(track: Track, lyric?: string | null): Promise<Blob> {
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const ctx = c.getContext('2d')!
  const art = await loadImage(`https://i.ytimg.com/vi/${track.playbackRef}/hqdefault.jpg`).catch(() => null)
  ctx.fillStyle = '#0b0b10'
  ctx.fillRect(0, 0, W, H)
  if (art) {
    ctx.save()
    ctx.filter = 'blur(70px) saturate(1.5) brightness(0.6)'
    ctx.drawImage(art, -200, -200, W + 400, H + 400)
    ctx.restore()
  }
  const g = ctx.createLinearGradient(0, 0, 0, H)
  g.addColorStop(0, 'rgba(0,0,0,0.1)')
  g.addColorStop(1, 'rgba(0,0,0,0.65)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, W, H)
  const size = 760
  const ax = (W - size) / 2
  const ay = 120
  ctx.save()
  ctx.shadowColor = 'rgba(0,0,0,0.5)'
  ctx.shadowBlur = 80
  ctx.shadowOffsetY = 30
  roundRect(ctx, ax, ay, size, size, 36)
  ctx.fillStyle = '#111'
  ctx.fill()
  ctx.restore()
  if (art) {
    ctx.save()
    roundRect(ctx, ax, ay, size, size, 36)
    ctx.clip()
    // hqdefault is 4:3 with letterbox bars: crop the centre square of the 16:9 picture.
    const sh = art.naturalHeight * 0.75
    const sy = (art.naturalHeight - sh) / 2
    const sx = (art.naturalWidth - sh) / 2
    ctx.drawImage(art, sx, sy, sh, sh, ax, ay, size, size)
    ctx.restore()
  }
  ctx.fillStyle = '#fff'
  ctx.textBaseline = 'alphabetic'
  ctx.font = '800 64px Inter, system-ui, sans-serif'
  const titleLines = wrap(ctx, track.title, W - 160, 2)
  let y = ay + size + 100
  for (const l of titleLines) { ctx.fillText(l, 80, y); y += 74 }
  ctx.fillStyle = 'rgba(255,255,255,0.75)'
  ctx.font = '500 40px Inter, system-ui, sans-serif'
  ctx.fillText(wrap(ctx, track.artist, W - 160, 1)[0] ?? '', 80, y + 4)
  y += 70
  if (lyric?.trim()) {
    ctx.fillStyle = 'rgba(255,255,255,0.92)'
    ctx.font = 'italic 400 44px "Instrument Serif", Georgia, serif'
    for (const l of wrap(ctx, `“${lyric.trim()}”`, W - 160, 2)) { ctx.fillText(l, 80, y); y += 54 }
  }
  // Brand mark: the arc "A" + wordmark.
  ctx.save()
  ctx.translate(80, H - 110)
  ctx.lineCap = 'round'
  const grad = ctx.createLinearGradient(0, 40, 50, 0)
  grad.addColorStop(0, '#52D6C3')
  grad.addColorStop(1, '#B9AEFF')
  ctx.strokeStyle = grad
  ctx.lineWidth = 6
  ctx.beginPath(); ctx.moveTo(0, 44); ctx.bezierCurveTo(8, 30, 15, 2, 25, 2); ctx.bezierCurveTo(35, 2, 42, 30, 50, 44); ctx.stroke()
  ctx.strokeStyle = '#fff'
  ctx.lineWidth = 5
  ctx.beginPath(); ctx.moveTo(11, 31); ctx.bezierCurveTo(15, 26, 19, 36, 25, 31); ctx.bezierCurveTo(31, 26, 35, 36, 39, 31); ctx.stroke()
  ctx.fillStyle = '#fff'
  ctx.font = '800 36px Manrope, Inter, sans-serif'
  ctx.fillText('Arnav Music', 70, 38)
  ctx.restore()
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('render'))), 'image/png'))
}

/** Shares the card (native share sheet with the image) or downloads it. */
export async function shareCard(track: Track, lyric?: string | null) {
  const blob = await renderShareCard(track, lyric)
  const file = new File([blob], `${track.title.replace(/[^\p{L}\p{N} -]/gu, '').slice(0, 40) || 'song'} - Arnav Music.png`, { type: 'image/png' })
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean }
  if (nav.canShare?.({ files: [file] })) {
    await nav.share({ files: [file], title: track.title, text: `${track.title} — ${track.artist}`, url: `${location.origin}/track/${track.playbackRef}` }).catch(() => undefined)
    return
  }
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = file.name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 3000)
}
