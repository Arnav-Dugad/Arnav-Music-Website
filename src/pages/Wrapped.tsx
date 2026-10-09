import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { motion } from 'motion/react'
import { Icon } from '../components/Icon'
import { Empty, Spinner } from '../components/ui'
import { useLibrary, liveEvents } from '../state/library'
import { trackRegistry } from '../state/tracks'
import { toast } from '../state/ui'
import { buildWrapped, monthKey, wrappedMonths, wrappedYears } from '../lib/wrapped'
import { drawSlide, loadWrappedAssets, recordWrapped, slidesFor, type WrappedAssets } from '../lib/wrappedVideo'
import { hashHue } from '../lib/color'

/** Your month in music as a story — and as a video you can share. */
export default function WrappedPage() {
  const { month } = useParams()
  const nav = useNavigate()
  // Back where you came from — or Home when opened straight from a link.
  const leave = () => (window.history.state?.idx > 0 ? nav(-1) : nav('/'))
  const events = useLibrary((s) => s.events)
  const live = useMemo(() => liveEvents(events), [events])
  const months = useMemo(() => wrappedMonths(live), [live])
  const years = useMemo(() => wrappedYears(live), [live])
  const key = month && /^\d{4}(-\d{2})?$/.test(month) ? month : months[0] ?? monthKey(Date.now())
  const w = useMemo(() => buildWrapped(key, live, (id) => trackRegistry.get(id)), [key, live])
  const hue = w?.songs[0] ? hashHue(w.songs[0].track.artist) : 260
  const slides = useMemo(() => (w ? slidesFor(w) : []), [w])
  const canvas = useRef<HTMLCanvasElement>(null)
  const [assets, setAssets] = useState<WrappedAssets | null>(null)
  const [slide, setSlide] = useState(0)
  const [paused, setPaused] = useState(false)
  const [recording, setRecording] = useState<number | null>(null)
  const clock = useRef({ start: performance.now(), pausedAt: 0 })

  useEffect(() => {
    setAssets(null)
    setSlide(0)
    clock.current = { start: performance.now(), pausedAt: 0 }
    if (w) void loadWrappedAssets(w).then(setAssets)
  }, [w])

  useEffect(() => {
    if (!w || !assets) return
    const g = canvas.current?.getContext('2d')
    if (!g) return
    let raf = 0
    const frame = () => {
      raf = requestAnimationFrame(frame)
      const now = paused ? clock.current.pausedAt : performance.now()
      const cur = slides[Math.min(slide, slides.length - 1)]
      const t = (now - clock.current.start) / cur.ms
      drawSlide(g, w, assets, cur.id, slide, Math.min(1, t), hue)
      if (t >= 1 && !paused) {
        if (slide < slides.length - 1) { clock.current.start = performance.now(); setSlide(slide + 1) } else setPaused(true)
      }
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [w, assets, slide, paused, hue, slides])

  const go = (d: number) => {
    const n = Math.max(0, Math.min(slides.length - 1, slide + d))
    clock.current = { start: performance.now(), pausedAt: performance.now() }
    setPaused(false)
    setSlide(n)
  }
  const hold = (on: boolean) => {
    if (on) { clock.current.pausedAt = performance.now(); setPaused(true) } else { clock.current.start += performance.now() - clock.current.pausedAt; setPaused(false) }
  }

  const share = async () => {
    if (!w || recording != null) return
    setRecording(0)
    try {
      const file = await recordWrapped(w, hue, (p) => setRecording(p))
      const nav2 = navigator as Navigator & { canShare?: (d: { files: File[] }) => boolean }
      if (nav2.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: `My ${w.label} in music`, text: `My ${w.label} on Arnav Music` }).catch(() => undefined)
      } else {
        const a = document.createElement('a')
        a.href = URL.createObjectURL(file)
        a.download = file.name
        a.click()
        setTimeout(() => URL.revokeObjectURL(a.href), 30_000)
        toast('Video saved to your downloads')
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : 'The video couldn’t be made')
    } finally {
      setRecording(null)
    }
  }

  if (!w) {
    return (
      <div className="page">
        <div className="wrapped-empty-top"><button className="icon-btn" aria-label="Close" onClick={leave}><Icon name="close" size={20} /></button></div>
        <Empty icon="story" title="No month to wrap yet" body="Listen for at least half an hour in a month and its story appears here." action={<button className="btn btn-primary" onClick={() => nav('/explore')}>Find music</button>} />
      </div>
    )
  }
  return (
    <div className="wrapped">
      <div className="wrapped-top">
        <button className="icon-btn" aria-label="Close" onClick={leave}><Icon name="close" size={20} /></button>
        <select className="lyr-select" value={key} onChange={(e) => nav(`/wrapped/${e.target.value}`)} aria-label="Month">
          {years.length > 0 && <optgroup label="Years">{years.map((y) => <option key={y} value={y}>{y} — the whole year</option>)}</optgroup>}
          <optgroup label="Months">{(months.length ? months : [key]).filter((m) => m.length === 7).map((m) => <option key={m} value={m}>{new Date(Number(m.slice(0, 4)), Number(m.slice(5)) - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</option>)}</optgroup>
        </select>
        <span className="grow" />
        <button className="btn btn-primary btn-sm" disabled={recording != null} onClick={() => void share()}>
          {recording != null ? <><Spinner size={14} /> Making video {Math.round(recording * 100)}%</> : <><Icon name="share" size={15} /> Share video</>}
        </button>
      </div>
      <motion.div className="wrapped-stage" initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} transition={{ type: 'spring', stiffness: 200, damping: 24 }}>
        <div className="wrapped-bars">
          {slides.map((sl, i) => <span key={`${key}-${i}`} className={i < slide ? 'done' : i === slide ? 'on' : ''} style={i === slide ? { animationDuration: `${sl.ms}ms`, animationPlayState: paused ? 'paused' : 'running' } : undefined} />)}
        </div>
        <canvas ref={canvas} width={720} height={1280} aria-label={`${w.label} in music`} />
        {!assets && <div className="wrapped-loading"><Spinner size={26} /></div>}
        <button className="wrapped-tap l" aria-label="Previous" onClick={() => go(-1)} onPointerDown={() => hold(true)} onPointerUp={() => hold(false)} />
        <button className="wrapped-tap r" aria-label="Next" onClick={() => go(1)} onPointerDown={() => hold(true)} onPointerUp={() => hold(false)} />
      </motion.div>
      <div className="t-caption wrapped-note">Made on this device from your listening. The video is silent — songs belong to their artists.</div>
    </div>
  )
}
