import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'motion/react'
import { useLyrics } from '../state/lyrics'
import { player, usePlayer, useProgress } from '../state/player'
import { activeIndex, isInstrumental, progress, type LyricLine } from '../lib/lyrics'
import { Icon } from './Icon'
import { Spinner } from './ui'
import { aiAvailability } from '../lib/ai'

const LEAD_MS = 140

/** Smoothly interpolated playback position (the store ticks at 4 Hz; lyrics animate at 60 fps). */
function usePositionClock() {
  const ref = useRef({ pos: useProgress.getState().position, at: performance.now() })
  useEffect(() => useProgress.subscribe((s) => { ref.current = { pos: s.position, at: performance.now() } }), [])
  return () => {
    const p = usePlayer.getState()
    const { pos, at } = ref.current
    return p.isPlaying && !p.isBuffering ? pos + Math.min(600, performance.now() - at) * p.rate : pos
  }
}

function SyncedLyrics({ lines, translation, romanized, size }: { lines: LyricLine[]; translation?: string[] | null; romanized?: string[] | null; size: 'lg' | 'md' }) {
  const box = useRef<HTMLDivElement>(null)
  const lineRefs = useRef<(HTMLDivElement | null)[]>([])
  const wordRefs = useRef<Map<number, HTMLSpanElement[]>>(new Map())
  const bgRefs = useRef<Map<number, HTMLSpanElement>>(new Map())
  const dotRefs = useRef<Map<number, HTMLSpanElement[]>>(new Map())
  const clock = usePositionClock()
  const state = useRef({ active: -2, manual: 0, free: false, freeTimer: 0 as unknown as ReturnType<typeof setTimeout> })
  const [, force] = useState(0)
  const sizeRef = useRef(size)
  sizeRef.current = size

  const layout = (active: number) => {
    const el = box.current
    if (!el) return
    const anchor = el.clientHeight * (sizeRef.current === 'lg' ? 0.32 : 0.36)
    const target = lineRefs.current[Math.max(0, active)]
    const top = target ? target.offsetTop + target.offsetHeight / 2 : 0
    const shift = anchor - top + state.current.manual
    lineRefs.current.forEach((ln, i) => {
      if (!ln) return
      const d = active < 0 ? i + 1 : Math.abs(i - active)
      ln.style.transform = `translate3d(0, ${shift}px, 0)`
      ln.style.transitionDelay = state.current.free ? '0ms' : `${Math.min(d, 9) * 34}ms`
      ln.dataset.state = i === active ? 'active' : i < active ? 'past' : 'future'
      ln.style.setProperty('--d', String(Math.min(d, 6)))
    })
  }

  useLayoutEffect(() => {
    state.current.active = -2
    layout(activeIndex(lines, clock() + LEAD_MS))
    const ro = new ResizeObserver(() => layout(state.current.active))
    if (box.current) ro.observe(box.current)
    return () => ro.disconnect()
  }, [lines, translation, size])

  useEffect(() => {
    let raf = 0
    let lastWordLine = -1
    const frame = () => {
      raf = requestAnimationFrame(frame)
      const pos = clock() + LEAD_MS
      const a = activeIndex(lines, pos)
      if (a !== state.current.active) {
        state.current.active = a
        if (!state.current.free) state.current.manual = 0
        layout(a)
        // Reset the previous line's fill so re-entering looks right.
        if (lastWordLine >= 0 && lastWordLine !== a) {
          wordRefs.current.get(lastWordLine)?.forEach((w) => w.style.setProperty('--p', '1'))
        }
      }
      if (a >= 0) {
        const ln = lines[a]
        const words = wordRefs.current.get(a)
        if (words) ln.words.forEach((w, i) => words[i]?.style.setProperty('--p', String(progress(w.start, w.end, pos))))
        const bg = bgRefs.current.get(a)
        if (bg) bg.style.setProperty('--p', String(progress(ln.start + 300, ln.end, pos)))
        const dots = dotRefs.current.get(a)
        if (dots) {
          const p = progress(ln.start, ln.end - 400, pos)
          dots.forEach((d, i) => d.style.setProperty('--p', String(Math.min(1, Math.max(0, p * 3 - i)))))
        }
        lastWordLine = a
      }
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [lines])

  const enterFree = (delta: number) => {
    const s = state.current
    s.free = true
    s.manual += delta
    box.current?.classList.add('free')
    layout(s.active)
    clearTimeout(s.freeTimer)
    s.freeTimer = setTimeout(() => {
      s.free = false
      s.manual = 0
      box.current?.classList.remove('free')
      layout(s.active)
      force((n) => n + 1)
    }, 2800)
  }

  const touch = useRef<number | null>(null)
  return (
    <div
      ref={box}
      className={`lyr synced ${size}`}
      onWheel={(e) => enterFree(-e.deltaY)}
      onTouchStart={(e) => { touch.current = e.touches[0].clientY }}
      onTouchMove={(e) => { if (touch.current != null) { const y = e.touches[0].clientY; enterFree(y - touch.current); touch.current = y } }}
      onTouchEnd={() => { touch.current = null }}
    >
      <div className="lyr-lines">
        {lines.map((ln, i) => {
          const inst = isInstrumental(ln)
          return (
            <div
              key={i}
              ref={(el) => { lineRefs.current[i] = el }}
              className={`lyr-line ${inst ? 'inst' : ''} ${ln.estimated ? 'est' : ''}`}
              onClick={() => { player().seek(Math.max(0, ln.start - 50)); state.current.free = false; state.current.manual = 0; box.current?.classList.remove('free') }}
            >
              {inst ? (
                <span className="lyr-dots" ref={(el) => { if (el) dotRefs.current.set(i, [...el.querySelectorAll('i')] as HTMLSpanElement[]) }}><i /><i /><i /></span>
              ) : (
                <>
                  {ln.text && (
                    <span className="lyr-main" ref={(el) => { if (el) wordRefs.current.set(i, [...el.querySelectorAll('.w')] as HTMLSpanElement[]) }}>
                      {ln.words.length ? ln.words.map((w, j) => <span key={j} className="w">{w.text}{j < ln.words.length - 1 ? ' ' : ''}</span>) : <span className="w">{ln.text}</span>}
                    </span>
                  )}
                  {ln.background && <span className="lyr-bg" ref={(el) => { if (el) bgRefs.current.set(i, el) }}>{ln.background}</span>}
                  {romanized?.[i] && <span className="lyr-tr roman">{romanized[i]}</span>}
                  {translation?.[i] && translation[i] !== ln.text && <span className="lyr-tr">{translation[i]}</span>}
                </>
              )}
            </div>
          )
        })}
        <div className="lyr-end" />
      </div>
    </div>
  )
}

function PlainLyrics({ lines, translation, size }: { lines: string[]; translation?: string[] | null; size: 'lg' | 'md' }) {
  return (
    <div className={`lyr plain ${size}`}>
      <div className="lyr-plain-note t-caption">These lyrics aren’t time-synced.</div>
      {lines.map((l, i) => (
        <motion.p key={i} className={l.trim() ? 'pl' : 'gap'} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i, 20) * 0.02 }}>
          {l}
          {translation?.[i] && translation[i] !== l && <span className="lyr-tr">{translation[i]}</span>}
        </motion.p>
      ))}
    </div>
  )
}

const LANGS = ['English', 'Hindi', 'Spanish', 'French', 'German', 'Japanese', 'Korean', 'Portuguese', 'Arabic', 'Tamil', 'Telugu', 'Bengali', 'Punjabi', 'Italian', 'Chinese']
function defaultLanguage() {
  try {
    const name = new Intl.DisplayNames(['en'], { type: 'language' }).of(navigator.language.split('-')[0])
    return name && LANGS.includes(name) ? name : 'English'
  } catch { return 'English' }
}

export function LyricsPanel({ size = 'lg' }: { size?: 'lg' | 'md' }) {
  const { status, lyrics, translation, showTranslation, translating, generating } = useLyrics()
  const [pasting, setPasting] = useState(false)
  const [text, setText] = useState('')
  const [lang, setLang] = useState(defaultLanguage)
  const tr = showTranslation ? translation : null
  const body = useMemo(() => {
    if (status === 'loading' || status === 'idle') return <div className="lyr-state"><Spinner size={22} /></div>
    if (status === 'off') return <div className="lyr-state"><Icon name="lyrics" size={28} /><div className="t-title">Online lyrics are off</div><div className="t-sub">Turn them on in Settings → Lyrics.</div></div>
    if (status === 'instrumental') return <div className="lyr-state"><Icon name="note" size={28} /><div className="t-title">Instrumental</div><div className="t-sub">Just the music — enjoy.</div></div>
    if ((status === 'none' || status === 'error') && !pasting) {
      return (
        <div className="lyr-state">
          <Icon name="lyrics" size={28} />
          <div className="t-title">{status === 'error' ? 'Lyrics couldn’t load' : 'No lyrics for this song yet'}</div>
          <div className="t-sub" style={{ maxWidth: 360 }}>LRCLIB doesn’t have this one. Arnav AI can write them from the song itself, labelled as AI-written.</div>
          <div className="row" style={{ marginTop: 12, flexWrap: 'wrap', justifyContent: 'center' }}>
            <button className="btn btn-primary btn-sm" disabled={generating || !!aiAvailability()} onClick={() => void useLyrics.getState().generate()}>
              {generating ? <Spinner size={14} /> : <Icon name="sparkles" size={15} />} Generate with Arnav AI
            </button>
            <button className="btn btn-secondary btn-sm" onClick={() => setPasting(true)}><Icon name="edit" size={15} /> Paste lyrics</button>
            {status === 'error' && <button className="btn btn-ghost btn-sm" onClick={() => void useLyrics.getState().load(true)}>Retry</button>}
          </div>
        </div>
      )
    }
    if (pasting) {
      return (
        <div className="lyr-state" style={{ alignItems: 'stretch', maxWidth: 520, margin: '0 auto', width: '100%' }}>
          <div className="t-title">Paste lyrics</div>
          <div className="t-sub">Plain text or LRC with [mm:ss.xx] timestamps.</div>
          <textarea className="field" rows={10} value={text} onChange={(e) => setText(e.target.value)} placeholder="[00:12.40] First line…" />
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn btn-ghost btn-sm" onClick={() => setPasting(false)}>Cancel</button>
            <button className="btn btn-primary btn-sm" disabled={!text.trim()} onClick={async () => { if (await useLyrics.getState().paste(text)) { setPasting(false); setText('') } }}>Save</button>
          </div>
        </div>
      )
    }
    if (!lyrics) return null
    return lyrics.kind === 'synced'
      ? <SyncedLyrics lines={lyrics.lines} translation={tr?.lines} romanized={tr?.romanized} size={size} />
      : <PlainLyrics lines={lyrics.lines} translation={tr?.lines} size={size} />
  }, [status, lyrics, tr, size, pasting, text, generating])

  return (
    <div className="lyr-panel">
      {body}
      {status === 'found' && lyrics && (
        <div className="lyr-bar">
          <span className={`badge ${lyrics.source === 'Arnav AI' ? 'ai' : ''}`}>{lyrics.source === 'Arnav AI' ? 'Written by Arnav AI' : lyrics.source === 'You' ? 'Your lyrics' : 'Lyrics · LRCLIB'}</span>
          <span className="grow" />
          {translation && (
            <button className={`chip ${showTranslation ? 'on' : ''}`} onClick={() => useLyrics.getState().set({ showTranslation: !showTranslation })}>
              <Icon name="translate" size={14} /> {translation.language}
            </button>
          )}
          {!translation && (
            <div className="row" style={{ gap: 6 }}>
              <select className="lyr-select" value={lang} onChange={(e) => setLang(e.target.value)} aria-label="Translate to">
                {LANGS.map((l) => <option key={l}>{l}</option>)}
              </select>
              <button className="chip" disabled={translating || !!aiAvailability()} onClick={() => void useLyrics.getState().translate(lang)}>
                {translating ? <Spinner size={13} /> : <Icon name="translate" size={14} />} Translate
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
