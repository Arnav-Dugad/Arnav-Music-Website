import { Fragment, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'motion/react'
import { useSettings } from '../state/settings'
import { useLyrics } from '../state/lyrics'
import { player, usePlayer, useProgress } from '../state/player'
import { activeIndex, estimateWords, guessLanguage, progress, type LyricLine, type LyricWord } from '../lib/lyrics'
import { aiAvailability } from '../lib/ai'
import { defaultLanguage, usePositionClock } from './Lyrics'
import { mainArtist, watchNextFor } from '../services/watchNext'
import type { Track } from '../lib/types'

const wordsCache = new WeakMap<LyricLine, LyricWord[]>()
/** A line's words with timing: the source's own, or spread over the line by syllables. */
function wordsOf(ln: LyricLine): LyricWord[] {
  if (ln.words.length) return ln.words
  let w = wordsCache.get(ln)
  if (!w) { w = estimateWords(ln.text, ln.start, ln.end); wordsCache.set(ln, w) }
  return w
}

/** Songs already offered a translation this visit (one try each). */
const translateTried = new Set<string>()

/**
 * Lyrics as subtitles over a music video, drawn on the layer that sits above it. Each word rises
 * into place as it's sung; songs with word-timed lyrics also fill word by word, karaoke-style.
 * For a song in another language, a translated line (Arnav AI) sits under the original.
 */
export function VideoCaptions() {
  const on = useSettings((s) => s.videoCaptions)
  const translateOn = useSettings((s) => s.videoCaptionsTranslate)
  const found = useLyrics((s) => (s.status === 'found' ? s.lyrics : null))
  const translation = useLyrics((s) => s.translation)
  const translating = useLyrics((s) => s.translating)
  const trackId = usePlayer((s) => s.queue[s.index]?.track.id ?? null)
  const lyrics = found && found.kind === 'synced' ? found : null
  const [idx, setIdx] = useState(-1)
  const [host, setHost] = useState<HTMLElement | null>(null)
  const wordRefs = useRef<(HTMLSpanElement | null)[]>([])
  const clock = usePositionClock()
  const clockRef = useRef(clock)
  clockRef.current = clock
  useEffect(() => { setHost(document.getElementById('yt-overlay')) }, [])

  // A song in another language: translate it once (saved for next time).
  useEffect(() => {
    if (!on || !translateOn || !lyrics || translation || !trackId || translateTried.has(trackId) || aiAvailability()) return
    const lang = guessLanguage(lyrics.lines.map((l) => l.text))
    const mine = defaultLanguage()
    if (!lang || lang === mine) return
    translateTried.add(trackId)
    void useLyrics.getState().translate(mine)
  }, [on, translateOn, lyrics, translation, trackId])

  useEffect(() => {
    if (!on || !lyrics) { setIdx(-1); return }
    const lines = lyrics.lines
    let raf = 0
    let last = -2
    const frame = () => {
      raf = requestAnimationFrame(frame)
      const pos = clockRef.current() + 120
      const a = activeIndex(lines, pos)
      const ln = a >= 0 && lines[a].text ? lines[a] : null
      const live = ln ? a : -1
      if (live !== last) { last = live; setIdx(live) }
      if (!ln) return
      wordsOf(ln).forEach((w, i) => {
        const el = wordRefs.current[i]
        if (!el || el.dataset.line !== String(a)) return
        const p = progress(w.start, w.end, pos)
        const st = p <= 0 ? '' : p >= 1 ? 'done' : 'on'
        if (el.dataset.s !== st) el.dataset.s = st
        el.style.setProperty('--p', p.toFixed(3))
      })
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [lyrics, on])

  if (!host || !lyrics) return null
  const ln = idx >= 0 ? lyrics.lines[idx] : null
  const words = ln ? wordsOf(ln) : []
  const tr = translateOn && translation && ln ? translation.lines[idx]?.trim() : null
  const showTr = !!tr && tr.toLowerCase() !== ln?.text.trim().toLowerCase()
  return createPortal(
    <div className="vcap">
      <AnimatePresence mode="wait" initial={false}>
        {on && ln && (
          <motion.div key={idx} className="vcap-line" data-timed={ln.estimated ? undefined : ''}
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, y: -8, filter: 'blur(3px)' }} transition={{ duration: 0.22 }}>
            <div className="vcap-main">
              {words.map((w, i) => (
                <Fragment key={i}>
                  <span ref={(el) => { wordRefs.current[i] = el }} data-line={idx} className="vw">{w.text}</span>{i < words.length - 1 ? ' ' : ''}
                </Fragment>
              ))}
            </div>
            {showTr && <div className="vcap-tr">{tr}</div>}
          </motion.div>
        )}
      </AnimatePresence>
      {on && translating && <div className="vcap-status">Translating the lyrics…</div>}
      <button className={`vcap-cc ${on ? 'on' : ''}`} aria-pressed={on} aria-label={on ? 'Hide lyrics on the video' : 'Show lyrics on the video'} title="Lyrics on the video"
        onClick={() => useSettings.getState().update({ videoCaptions: !on })}>CC</button>
    </div>,
    host,
  )
}

/**
 * The video's colours light the whole Now Playing background, like YouTube's ambient mode: frames
 * from across the video (YouTube keeps stills at the start and at ¼, ½ and ¾ of the way through),
 * heavily blurred, blending from one to the next as the video plays. Brightest in theatre mode.
 */
const KEYS = [0, 0.25, 0.5, 0.75, 1]
export function VideoAmbient({ track }: { track: Track }) {
  const refs = useRef<(HTMLDivElement | null)[]>([])
  const ref = track.playbackRef
  const frames = [`https://i.ytimg.com/vi/${ref}/hqdefault.jpg`, `https://i.ytimg.com/vi/${ref}/1.jpg`, `https://i.ytimg.com/vi/${ref}/2.jpg`, `https://i.ytimg.com/vi/${ref}/3.jpg`]
  useEffect(() => {
    const paint = (posMs: number) => {
      const d = usePlayer.getState().duration || track.durationMs || 0
      const f = d ? Math.min(1, Math.max(0, posMs / d)) : 0
      // Frame k sits at KEYS[k]; the last key (the end) is the first frame again.
      const weights = [0, 0, 0, 0]
      for (let k = 0; k < KEYS.length - 1; k++) {
        if (f >= KEYS[k] && f <= KEYS[k + 1]) {
          const t = (f - KEYS[k]) / (KEYS[k + 1] - KEYS[k])
          weights[k % 4] += 1 - t
          weights[(k + 1) % 4] += t
          break
        }
      }
      refs.current.forEach((el, i) => { if (el) el.style.opacity = weights[i].toFixed(3) })
    }
    paint(useProgress.getState().position)
    return useProgress.subscribe((s) => paint(s.position))
  }, [ref, track.durationMs])
  return (
    <div className="np-ambient" aria-hidden>
      {frames.map((src, i) => <div key={src} ref={(el) => { refs.current[i] = el }} className="np-ambient-frame" style={{ backgroundImage: `url("${src}")` }} />)}
    </div>
  )
}

/** "Watch next": more music videos by this artist, under the video. */
export function WatchNext({ track }: { track: Track }) {
  const [items, setItems] = useState<Track[]>([])
  useEffect(() => {
    let alive = true
    setItems([])
    void watchNextFor(track).then((r) => { if (alive) setItems(r) })
    return () => { alive = false }
  }, [track.id]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!items.length) return null
  const play = (t: Track) => {
    const s = usePlayer.getState()
    player().playNext([t])
    player().jumpTo(s.index + 1)
  }
  return (
    <motion.section className="np-watch" aria-label={`More music videos by ${mainArtist(track)}`} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}>
      <div className="np-watch-head"><span className="t-eyebrow">Watch next</span><span className="np-watch-artist">{mainArtist(track)}</span></div>
      <div className="np-watch-row">
        {items.map((t) => (
          <button key={t.id} className="np-watch-card" onClick={() => play(t)} title={t.title}>
            <span className="np-watch-thumb"><img src={`https://i.ytimg.com/vi/${t.playbackRef}/mqdefault.jpg`} alt="" loading="lazy" /></span>
            <span className="np-watch-title">{t.title}</span>
          </button>
        ))}
      </div>
    </motion.section>
  )
}
