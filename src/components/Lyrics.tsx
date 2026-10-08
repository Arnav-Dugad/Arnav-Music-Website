import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { useLyrics } from '../state/lyrics'
import { currentTrack, player, usePlayer, useProgress } from '../state/player'
import { activeIndex, isInstrumental, progress, type LyricLine } from '../lib/lyrics'
import { Icon } from './Icon'
import { Spinner } from './ui'
import { aiAvailability } from '../lib/ai'
import { useSettings } from '../state/settings'
import { songNotes } from '../lib/aiFeatures'

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

export function SyncedLyrics({ lines, translation, romanized, size, dual = false }: { lines: LyricLine[]; translation?: string[] | null; romanized?: string[] | null; size: 'lg' | 'md' | 'xl'; dual?: boolean }) {
  const box = useRef<HTMLDivElement>(null)
  const lineRefs = useRef<(HTMLDivElement | null)[]>([])
  const wordRefs = useRef<Map<number, HTMLSpanElement[]>>(new Map())
  const bgRefs = useRef<Map<number, HTMLSpanElement>>(new Map())
  const dotRefs = useRef<Map<number, HTMLSpanElement[]>>(new Map())
  const clock = usePositionClock()
  const state = useRef({ active: -2, manual: 0, free: false, freeTimer: 0 as unknown as ReturnType<typeof setTimeout> })
  const [, force] = useState(0)
  const beat = useRef({ line: -1, word: -1 })
  const motionLevel = useSettings((s) => s.motion)
  const energy = usePlayer((s) => s.queue[s.index]?.track.energy ?? 0.5)
  const pulse = useRef(0)
  pulse.current = motionLevel === 'full' ? 0.008 + 0.012 * energy : 0
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
          wordRefs.current.get(lastWordLine)?.forEach((w) => { w.style.setProperty('--p', '1'); w.dataset.s = 'done' })
        }
      }
      if (a >= 0) {
        const ln = lines[a]
        const words = wordRefs.current.get(a)
        if (words) ln.words.forEach((w, i) => {
          const el = words[i]
          if (!el) return
          const p = progress(w.start, w.end, pos)
          el.style.setProperty('--p', String(p))
          // Apple-style: each word rises and sharpens as it's sung.
          const st = p <= 0 ? '' : p >= 1 ? 'done' : 'on'
          if (el.dataset.s !== st) { el.dataset.s = st }
        })
        // A light pulse as each new word is sung — the rhythm of the vocal line.
        let wi = -1
        for (let i = 0; i < ln.words.length; i++) if (ln.words[i].start <= pos) wi = i
        if (wi !== beat.current.word || a !== beat.current.line) {
          if (wi >= 0 && a === beat.current.line && wi > beat.current.word && pulse.current) {
            const main = lineRefs.current[a]?.querySelector('.lyr-main') as HTMLElement | null
            main?.animate([{ transform: 'scale(1)' }, { transform: `scale(${1 + pulse.current})` }, { transform: 'scale(1)' }], { duration: 300, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' })
          }
          beat.current = { line: a, word: wi }
        }
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
      className={`lyr synced ${size} ${dual ? 'dual' : ''}`}
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
                      {ln.words.length ? ln.words.map((w, j) => <span key={j}><span className="w">{w.text}</span>{j < ln.words.length - 1 ? ' ' : ''}</span>) : <span className="w">{ln.text}</span>}
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

export function PlainLyrics({ lines, translation, size }: { lines: string[]; translation?: string[] | null; size: 'lg' | 'md' | 'xl' }) {
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

const SOURCE_LABEL: Record<string, string> = { LRCLIB: 'LRCLIB', NetEase: 'NetEase', 'YouTube description': 'From the uploader', 'Arnav AI': 'Written by Arnav AI', You: 'Your lyrics' }

function timingLabel(t: { offsetMs: number; scale: number; source: string }): string | null {
  const s = `${t.offsetMs >= 0 ? '+' : '−'}${(Math.abs(t.offsetMs) / 1000).toFixed(1)} s`
  if (t.source === 'you') return `Your timing · ${s}`
  if (t.source === 'community') return `Timing from listeners · ${s}`
  if (t.source === 'auto') return `Aligned to this video · ${s}`
  return null
}

/** "Fix lyrics": timing nudges, tap-to-sync, Arnav AI alignment and every other version found. */
function FixSheet({ onClose }: { onClose: () => void }) {
  const { pick, chosen, timing, lyrics, aligning, official } = useLyrics()
  const [tapping, setTapping] = useState(false)
  const pos = useProgress((s) => s.position)
  const synced = lyrics?.kind === 'synced'
  const lines = synced ? lyrics.lines : []
  const cur = synced ? activeIndex(lines, pos) : -1
  // The next sung line: tap the moment you hear it start.
  let next = cur + 1
  while (next < lines.length && isInstrumental(lines[next])) next++
  const label = timingLabel(timing)
  const s = useLyrics.getState()
  return (
    <motion.div className="lyr-fix glass-thick" initial={{ opacity: 0, y: 16, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 12 }} transition={{ type: 'spring', stiffness: 380, damping: 32 }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div className="t-title">Fix lyrics</div>
        <button className="icon-btn sm" aria-label="Close" onClick={onClose}><Icon name="close" size={14} /></button>
      </div>
      {synced && (
        <section>
          <div className="lyr-fix-h">Timing <span className="t-caption">{label ?? 'As published'}</span></div>
          {tapping ? (
            <div className="lyr-tap">
              <div className="t-caption">Tap the moment you hear</div>
              <div className="lyr-tap-line">{lines[next]?.text ?? '—'}</div>
              <div className="row" style={{ justifyContent: 'center' }}>
                <motion.button whileTap={{ scale: 0.92 }} className="btn btn-primary" disabled={next >= lines.length} onClick={() => s.tapSync(next)}>It starts now</motion.button>
                <button className="btn btn-ghost btn-sm" onClick={() => setTapping(false)}>Done</button>
              </div>
            </div>
          ) : (
            <>
              <div className="lyr-nudge">
                <button className="chip" onClick={() => s.nudge(-500)} title="Lyrics earlier">−0.5 s</button>
                <button className="chip" onClick={() => s.nudge(-100)}>−0.1</button>
                <span className="lyr-nudge-v">{timing.offsetMs >= 0 ? '+' : '−'}{(Math.abs(timing.offsetMs) / 1000).toFixed(1)} s</span>
                <button className="chip" onClick={() => s.nudge(100)}>+0.1</button>
                <button className="chip" onClick={() => s.nudge(500)} title="Lyrics later">+0.5 s</button>
              </div>
              <div className="row" style={{ flexWrap: 'wrap' }}>
                <button className="chip" onClick={() => setTapping(true)}><Icon name="hand" size={14} /> Tap to sync</button>
                <button className="chip" disabled={aligning || !!aiAvailability()} onClick={() => void s.alignAi()}>{aligning ? <Spinner size={13} /> : <Icon name="sparkles" size={14} />} Fix with Arnav AI</button>
                {timing.source !== 'none' && <button className="chip" onClick={() => s.resetTiming()}>Reset</button>}
              </div>
              <div className="t-caption">Fixes you make are shared, so the next listener gets this song right.</div>
            </>
          )}
        </section>
      )}
      {(pick?.candidates.length ?? 0) > 0 && (
        <section>
          <div className="lyr-fix-h">Versions <span className="t-caption">{pick!.candidates.length} found</span></div>
          <div className="lyr-versions">
            {pick!.candidates.slice(0, 8).map((c) => (
              <button key={c.key} className={`lyr-version ${chosen?.key === c.key ? 'on' : ''}`} onClick={() => s.choose(c.key)}>
                <span className="lyr-version-t ellipsis">{c.title} <span className="t-caption">· {c.artist}</span></span>
                <span className="t-caption ellipsis">
                  {c.source}{c.durationMs ? ` · ${Math.floor(c.durationMs / 60000)}:${String(Math.round((c.durationMs % 60000) / 1000)).padStart(2, '0')}` : ''}{c.synced ? ' · synced' : ' · plain'}{c.reasons.length ? ` · ${c.reasons.slice(0, 2).join(', ')}` : ''}
                </span>
                {chosen?.key === c.key && <Icon name="check" size={15} />}
              </button>
            ))}
            {official && (
              <button className={`lyr-version ${chosen?.key === 'desc' ? 'on' : ''}`} onClick={() => s.useOfficial()}>
                <span className="lyr-version-t">Official lyrics</span>
                <span className="t-caption">From the uploader’s description · plain</span>
                {chosen?.key === 'desc' && <Icon name="check" size={15} />}
              </button>
            )}
          </div>
        </section>
      )}
    </motion.div>
  )
}

export function LyricsPanel({ size = 'lg', dual = false }: { size?: 'lg' | 'md' | 'xl'; dual?: boolean }) {
  const { status, lyrics, translation, showTranslation, translating, generating, chosen, timing, pick } = useLyrics()
  const [pasting, setPasting] = useState(false)
  const [fixing, setFixing] = useState(false)
  const [text, setText] = useState('')
  const [lang, setLang] = useState(defaultLanguage)
  const [notes, setNotes] = useState<{ id: string; text: string } | null>(null)
  const [notesBusy, setNotesBusy] = useState(false)
  const about = async () => {
    const t = currentTrack()
    if (!t || !lyrics) return
    if (notes?.id === t.id) { setNotes(null); return }
    setNotesBusy(true)
    try {
      const lines = lyrics.kind === 'synced' ? lyrics.lines.map((l) => l.text) : lyrics.lines
      const r = await songNotes(t, lines)
      setNotes(r ? { id: t.id, text: r.text } : { id: t.id, text: 'Arnav AI couldn’t write notes for this song right now.' })
    } finally { setNotesBusy(false) }
  }
  const tr = showTranslation ? translation : null
  const body = useMemo(() => {
    if (status === 'loading' || status === 'idle') return <div className="lyr-state"><Spinner size={22} /><div className="t-caption">Finding the best lyrics…</div></div>
    if (status === 'off') return <div className="lyr-state"><Icon name="lyrics" size={28} /><div className="t-title">Online lyrics are off</div><div className="t-sub">Turn them on in Settings → Lyrics.</div></div>
    if (status === 'instrumental') return <div className="lyr-state"><Icon name="note" size={28} /><div className="t-title">Instrumental</div><div className="t-sub">Just the music — enjoy.</div></div>
    if ((status === 'none' || status === 'error') && !pasting) {
      return (
        <div className="lyr-state">
          <Icon name="lyrics" size={28} />
          <div className="t-title">{status === 'error' ? 'Lyrics couldn’t load' : 'No lyrics for this song yet'}</div>
          <div className="t-sub" style={{ maxWidth: 360 }}>LRCLIB, NetEase and the uploader don’t have this one. Arnav AI can write them from the song itself, labelled as AI-written.</div>
          <div className="row" style={{ marginTop: 12, flexWrap: 'wrap', justifyContent: 'center' }}>
            <button className="btn btn-primary btn-sm" disabled={generating || !!aiAvailability()} onClick={() => void useLyrics.getState().generate()}>
              {generating ? <Spinner size={14} /> : <Icon name="sparkles" size={15} />} Generate with Arnav AI
            </button>
            <button className="btn btn-secondary btn-sm" onClick={() => setPasting(true)}><Icon name="edit" size={15} /> Paste lyrics</button>
            {(pick?.candidates.length ?? 0) > 0 && <button className="btn btn-ghost btn-sm" onClick={() => setFixing(true)}>See {pick!.candidates.length} possible matches</button>}
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
      ? <SyncedLyrics lines={lyrics.lines} translation={tr?.lines} romanized={tr?.romanized} size={size} dual={dual && !!tr} />
      : <PlainLyrics lines={lyrics.lines} translation={tr?.lines} size={size} />
  }, [status, lyrics, tr, size, pasting, text, generating, pick, dual])

  const src = chosen ? SOURCE_LABEL[chosen.source] ?? chosen.source : 'Lyrics'
  const tl = timingLabel(timing)
  return (
    <div className="lyr-panel">
      {body}
      <AnimatePresence>
        {notes && notes.id === currentTrack()?.id && (
          <motion.div className="lyr-notes glass-thick" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 10 }}>
            <div className="row" style={{ justifyContent: 'space-between' }}><span className="badge ai">About this song · Arnav AI</span><button className="icon-btn sm" aria-label="Close" onClick={() => setNotes(null)}><Icon name="close" size={14} /></button></div>
            <p>{notes.text}</p>
          </motion.div>
        )}
        {fixing && <FixSheet onClose={() => setFixing(false)} />}
      </AnimatePresence>
      {status === 'found' && lyrics && (
        <div className="lyr-bar">
          <button className={`chip lyr-src ${chosen?.source === 'Arnav AI' ? 'ai' : ''} ${fixing ? 'on' : ''}`} onClick={() => setFixing((f) => !f)} title="Timing off or wrong lyrics? Fix them">
            <Icon name="tune" size={14} /> {src}{tl ? <span className="lyr-src-t"> · {tl.split(' · ')[1]}</span> : null}
          </button>
          <span className="grow" />
          {size !== 'xl' && <button className="chip" onClick={() => useLyrics.getState().set({ cinematic: true })} title="Cinematic full screen"><Icon name="expand" size={14} /> Cinematic</button>}
          <button className={`chip ${notes ? 'on' : ''}`} disabled={notesBusy || !!aiAvailability()} onClick={() => void about()}>{notesBusy ? <Spinner size={13} /> : <Icon name="info" size={14} />} About</button>
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
