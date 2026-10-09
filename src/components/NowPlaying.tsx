import { AnimatePresence, motion, useDragControls, useMotionValue, useTransform, animate as animateValue, type PanInfo } from 'motion/react'
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Icon } from './Icon'
import { Artwork, Segmented, Sheet, spring, Spinner } from './ui'
import { Progress, VolumeSlider } from './Progress'
import { ArtistLinks, LikeButton, albumHref, openTrackMenu } from './TrackRow'
import { PlayPauseIcon } from './PlayerBar'
import { LyricsPanel } from './Lyrics'
import { QueuePanel } from './Queue'
import { useVideoSlot } from '../player/VideoHost'
import { CoverParticles } from './CoverParticles'
import { BeatShader } from './BeatShader'
import { RoomReactBar } from './TogetherLayer'
import { ListenersPill, useSendSheet } from './Social'
import { ChorusButton, SectionStrip } from './SongMap'
import { useMoodPick } from '../services/moodAutomix'
import { useCurrentPalette } from '../hooks'
import { rescue, setMode } from '../player/controller'
import { errorCopy } from '../player/youtube'
import { usePlayer, player, useProgress } from '../state/player'
import { useSettings } from '../state/settings'
import { useIsDesktop } from '../hooks'
import { ui } from '../state/ui'
import { artworkFor } from '../lib/classify'
import type { Track } from '../lib/types'

function VideoSlot() {
  const ref = useVideoSlot<HTMLDivElement>()
  return <div ref={ref} className="np-video-slot" />
}

function SleepSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const sleep = usePlayer((s) => s.sleep)
  const set = (s: Parameters<ReturnType<typeof player>['setSleep']>[0]) => { player().setSleep(s); onClose() }
  return (
    <Sheet open={open} onClose={onClose} title="Sleep timer" width={420}>
      <div className="col" style={{ gap: 6 }}>
        {[5, 10, 15, 30, 45, 60].map((m) => (
          <button key={m} className="menu-item" onClick={() => set({ mode: 'time', minutes: m, endsAt: Date.now() + m * 60_000 })}>
            <Icon name="moon" size={17} /> {m} minutes
          </button>
        ))}
        <button className="menu-item" onClick={() => set({ mode: 'track' })}><Icon name="note" size={17} /> End of this song</button>
        <button className="menu-item" onClick={() => set({ mode: 'queue' })}><Icon name="queue" size={17} /> End of the queue</button>
        {sleep && <button className="menu-item danger" onClick={() => set(null)}><Icon name="close" size={17} /> Turn off timer</button>}
      </div>
    </Sheet>
  )
}

function SleepBadge() {
  const sleep = usePlayer((s) => s.sleep)
  const [, tick] = useState(0)
  useEffect(() => {
    if (sleep?.mode !== 'time') return
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [sleep])
  if (!sleep) return null
  const label = sleep.mode === 'time' ? `${Math.max(0, Math.ceil((sleep.endsAt - Date.now()) / 60_000))} min` : sleep.mode === 'track' ? 'End of song' : 'End of queue'
  return <span className="np-sleep"><Icon name="moon" size={12} /> {label}</span>
}

/** The artwork: breathes while playing, settles when paused; songs swap with a depth transition. */
function Cover({ track, playing, showVideo, compact = false }: { track: Track; playing: boolean; showVideo: boolean; compact?: boolean }) {
  const breathing = useSettings((s) => s.coverBreathing && s.motion !== 'off')
  const vinyl = useSettings((s) => s.vinylMode)
  // On a phone the record peeks out less, so the cover stays on screen.
  // On a phone, or beside the lyrics/queue, the record peeks out less so nothing overlaps.
  const narrow = compact || (typeof window !== 'undefined' && window.innerWidth < 640)
  const [ripple, setRipple] = useState<{ side: 'l' | 'r'; n: number; secs: number } | null>(null)
  const lastTap = useRef<{ t: number; side: 'l' | 'r'; secs: number }>({ t: 0, side: 'l', secs: 0 })
  const x = useMotionValue(0)
  const rotate = useTransform(x, [-200, 200], [-6, 6])
  const onTap = (e: React.MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    const side: 'l' | 'r' = e.clientX - r.left < r.width / 2 ? 'l' : 'r'
    const now = performance.now()
    const l = lastTap.current
    if (now - l.t < 320 && l.side === side) {
      const secs = l.secs + 5
      lastTap.current = { t: now, side, secs }
      player().seek(useProgress.getState().position + (side === 'r' ? 5000 : -5000))
      setRipple({ side, n: now, secs })
    } else {
      lastTap.current = { t: now, side, secs: 0 }
    }
  }
  const onDragEnd = (_: unknown, info: PanInfo) => {
    if (info.offset.x < -90 || info.velocity.x < -500) player().next()
    else if (info.offset.x > 90 || info.velocity.x > 500) player().prev(0)
    void animateValue(x, 0, spring)
  }
  useEffect(() => {
    if (!ripple) return
    const t = setTimeout(() => setRipple(null), 700)
    return () => clearTimeout(t)
  }, [ripple])
  return (
    <div className="np-cover-stage">
      <motion.div
        className="np-cover-frame"
        animate={{ scale: showVideo ? 1 : playing || !breathing ? 1 : 0.86 }}
        transition={{ type: 'spring', stiffness: 170, damping: 22 }}
      >
        {showVideo ? (
          <div className="np-video"><VideoSlot /></div>
        ) : (
          <motion.div
            className="np-cover-drag"
            drag="x"
            dragConstraints={{ left: 0, right: 0 }}
            dragElastic={0.5}
            style={{ x, rotate }}
            onDragEnd={onDragEnd}
            onClick={onTap}
          >
            {vinyl && (
              // The record slides out of its sleeve and spins (33⅓ rpm) while the song plays.
              <motion.div className={`vinyl ${playing ? 'spin' : ''}`} initial={false} animate={{ x: playing ? (compact ? '7%' : narrow ? '20%' : '30%') : '0%', opacity: 1 }} transition={{ type: 'spring', stiffness: 90, damping: 16 }} aria-hidden>
                <div className="vinyl-spin">
                  <div className="vinyl-grooves" />
                  <div className="vinyl-label"><Artwork src={artworkFor(track, 'sm')} seed={track.artist} /></div>
                  <div className="vinyl-hole" />
                </div>
              </motion.div>
            )}
            {vinyl && (
              // The tonearm lowers onto the record on play and lifts away on pause.
              <motion.svg className={`tonearm ${narrow ? 'narrow' : ''}`} viewBox="0 0 100 220" aria-hidden initial={false}
                animate={{ rotate: playing ? 0 : -26, scale: playing ? 1 : 1.03, filter: playing ? 'drop-shadow(0 6px 8px rgba(0,0,0,.45))' : 'drop-shadow(0 16px 18px rgba(0,0,0,.35))' }}
                transition={{ type: 'spring', stiffness: 70, damping: 14, mass: 1.1, delay: playing ? 0.35 : 0 }}>
                <defs>
                  <linearGradient id="arm-metal" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#b9bcc4" /><stop offset=".5" stopColor="#f4f5f8" /><stop offset="1" stopColor="#8d9099" /></linearGradient>
                </defs>
                <circle cx="78" cy="16" r="14" fill="#1b1c20" stroke="#3a3c43" strokeWidth="2" />
                <circle cx="78" cy="16" r="6" fill="url(#arm-metal)" />
                <path d="M78 22 L74 120 Q72 150 52 176" fill="none" stroke="url(#arm-metal)" strokeWidth="5" strokeLinecap="round" />
                <rect x="36" y="168" width="24" height="34" rx="5" transform="rotate(38 48 185)" fill="#26272c" stroke="#55575f" strokeWidth="1.5" />
                <rect x="88" y="4" width="10" height="24" rx="3" fill="#2a2b30" />
              </motion.svg>
            )}
            <motion.div className="vinyl-sleeve" initial={false} animate={{ x: vinyl && playing ? (compact ? '-3%' : narrow ? '-9%' : '-16%') : '0%', rotate: vinyl && playing ? -2 : 0, scale: vinyl && narrow && !compact ? 0.9 : 1 }} transition={{ type: 'spring', stiffness: 90, damping: 16 }}>
            <motion.div layoutId="np-art" className="np-cover" transition={spring}>
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.div
                  key={track.id}
                  className="np-cover-inner"
                  initial={{ opacity: 0, scale: 1.08, filter: 'blur(14px)' }}
                  animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
                  exit={{ opacity: 0, scale: 0.9, filter: 'blur(10px)' }}
                  transition={{ duration: 0.55, ease: [0.32, 0.72, 0, 1] }}
                >
                  <Artwork src={artworkFor(track)} seed={track.artist} eager hi />
                </motion.div>
              </AnimatePresence>
            </motion.div>
            </motion.div>
            <CoverParticles id={track.id} art={artworkFor(track, 'sm')} />
            <div className={`np-cover-glow ${playing ? 'on' : ''}`} />
          </motion.div>
        )}
        <AnimatePresence>
          {ripple && (
            <motion.div key={ripple.n} className={`np-ripple ${ripple.side}`} initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }}>
              <Icon name={ripple.side === 'r' ? 'nextFill' : 'prevFill'} size={18} /> {ripple.secs}s
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </div>
  )
}

function IssueCard() {
  const issue = usePlayer((s) => s.issue)
  const track = usePlayer((s) => s.queue[s.index]?.track)
  if (!issue || !track) return null
  return (
    <motion.div className="np-issue glass" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
      <div className="t-headline">Can’t play this upload</div>
      <div className="t-sub">{errorCopy(issue.code)}</div>
      <div className="row" style={{ marginTop: 10, flexWrap: 'wrap', gap: 8 }}>
        <button className="btn btn-primary btn-sm" disabled={issue.resolving} onClick={() => void rescue()}>{issue.resolving ? <Spinner size={14} /> : <Icon name="search" size={15} />} Find another upload</button>
        <a className="btn btn-secondary btn-sm" href={`https://music.youtube.com/watch?v=${track.playbackRef}`} target="_blank" rel="noreferrer"><Icon name="external" size={15} /> YouTube Music</a>
        <button className="btn btn-ghost btn-sm" onClick={() => player().next()}>Skip</button>
      </div>
    </motion.div>
  )
}

export function NowPlaying() {
  const expanded = usePlayer((s) => s.expanded)
  const track = usePlayer((s) => s.queue[s.index]?.track ?? null)
  return (
    <AnimatePresence>
      {expanded && track && <NowPlayingView key="np" track={track} />}
    </AnimatePresence>
  )
}

function NowPlayingView({ track }: { track: Track }) {
  const moodPick = useMoodPick()
  const palette = useCurrentPalette()
  const nav = useNavigate()
  const desktop = useIsDesktop()
  const playing = usePlayer((s) => s.wantPlaying)
  const buffering = usePlayer((s) => s.isBuffering && s.wantPlaying)
  const shuffle = usePlayer((s) => s.shuffle)
  const repeat = usePlayer((s) => s.repeat)
  const panel = usePlayer((s) => s.panel)
  const mode = usePlayer((s) => s.mode)
  const resolving = usePlayer((s) => s.resolvingMode)
  const context = usePlayer((s) => s.context)
  const rate = usePlayer((s) => s.rate)
  const upNext = usePlayer((s) => s.queue[s.index + 1]?.track ?? null)
  const { ambientIdle, movingGradient } = useSettings()
  const [idle, setIdle] = useState(false)
  const [sleepOpen, setSleepOpen] = useState(false)
  const idleTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const close = () => player().setExpanded(false)
  // An audio upload (a Topic "art track") is only the cover as a video: show the real artwork instead.
  const artTrack = track?.variant === 'SONG' || /- Topic$/i.test(track?.channelTitle ?? '')
  const showVideo = mode === 'VIDEO' && !artTrack
  const dragControls = useDragControls()

  useEffect(() => {
    const wake = () => {
      setIdle(false)
      clearTimeout(idleTimer.current)
      if (ambientIdle) idleTimer.current = setTimeout(() => { if (usePlayer.getState().isPlaying) setIdle(true) }, 9000)
    }
    wake()
    window.addEventListener('pointermove', wake)
    window.addEventListener('keydown', wake)
    window.addEventListener('pointerdown', wake)
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('.sheet-root, .menu-root, .palette-root')) close() }
    window.addEventListener('keydown', onKey)
    return () => {
      clearTimeout(idleTimer.current)
      window.removeEventListener('pointermove', wake)
      window.removeEventListener('keydown', wake)
      window.removeEventListener('pointerdown', wake)
      window.removeEventListener('keydown', onKey)
    }
  }, [ambientIdle])

  const onDragEnd = (_: unknown, info: PanInfo) => { if (info.offset.y > 140 || info.velocity.y > 700) close() }
  const split = desktop && panel != null

  return (
    <motion.div
      className={`np ${idle ? 'idle' : ''} ${split ? 'split' : ''} ${panel && !desktop ? 'mobile-panel' : ''}`}
      initial={{ opacity: 0, y: desktop ? 0 : '8%' }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: desktop ? 0 : '10%', transition: { duration: 0.28 } }}
      transition={{ type: 'spring', stiffness: 300, damping: 34 }}
      drag={desktop ? false : 'y'}
      dragControls={dragControls}
      dragListener={false}
      dragConstraints={{ top: 0, bottom: 0 }}
      dragElastic={{ top: 0, bottom: 0.6 }}
      onDragEnd={onDragEnd}
      role="dialog"
      aria-label="Now Playing"
    >
      <div className={`np-bg living ${movingGradient ? '' : 'static'}`}>
        <div className="blob b1" /><div className="blob b2" /><div className="blob b3" />
        <BeatShader track={track} palette={palette} />
        <AnimatePresence initial={false}>
          <motion.img key={track.id} className="np-bg-art" src={artworkFor(track)} alt="" initial={{ opacity: 0 }} animate={{ opacity: 0.55 }} exit={{ opacity: 0 }} transition={{ duration: 1.2 }} />
        </AnimatePresence>
        <div className="grain" />
        <div className="np-vignette" />
      </div>
      <div className="np-edge" aria-hidden />

      <header className="np-top" onPointerDown={(e) => { if (!desktop && !(e.target as HTMLElement).closest('button')) dragControls.start(e) }}>
        {!desktop && <span className="np-grabber" aria-hidden />}
        <button className="icon-btn" aria-label="Close Now Playing" onClick={close}><Icon name="chevronDown" size={24} /></button>
        <div className="np-context">
          <span className="t-eyebrow" style={{ color: 'rgba(255,255,255,.6)' }}>Playing from</span>
          <span className="ellipsis" style={{ fontWeight: 650, fontSize: 13.5 }}>{context ?? 'Your queue'}</span>
        </div>
        <div className="np-top-right">
          <div className="np-mode">
            <Segmented id="np-mode" size="sm" value={mode} onChange={(m) => void setMode(m)} options={[{ value: 'SONG', label: 'Song' }, { value: 'VIDEO', label: resolving ? <><Spinner size={11} /> Video</> : 'Video' }]} />
          </div>
          <button className="icon-btn" aria-label="Send to friends" title="Send to friends" onClick={() => useSendSheet.getState().open(track)}><Icon name="send" size={18} /></button>
          <button className="icon-btn np-phone" aria-label="Continue on your phone" title="Continue on your phone" onClick={() => ui().set({ phoneOpen: true })}><Icon name="phone" size={19} /></button>
          <button className="icon-btn" aria-label="More" onClick={(e) => openTrackMenu(e, track)}><Icon name="more" size={20} /></button>
        </div>
      </header>

      <div className="np-body">
        <section className="np-stage">
          <div className="np-cover-wrap">
            <Cover track={track} playing={playing} showVideo={showVideo} compact={split} />
            <AnimatePresence>
              {mode === 'VIDEO' && artTrack && (
                <motion.div className="np-video-note glass-thin" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 6 }}>
                  {resolving ? <><Spinner size={12} /> Finding the music video…</> : <><Icon name="info" size={13} /> No music video for this song</>}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
          <div className="np-info">
            <div className="np-meta">
              <AnimatePresence mode="wait" initial={false}>
                <motion.div key={track.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.3 }} style={{ minWidth: 0 }}>
                  <div className="np-title ellipsis">{track.title}</div>
                  <div className="np-artist ellipsis"><ArtistLinks track={track} onNavigate={close} />{track.album ? <span className="np-album"> — <button className="link" onClick={() => { close(); nav(albumHref(track)) }}>{track.album}</button></span> : null}</div>
                </motion.div>
              </AnimatePresence>
            </div>
            <LikeButton track={track} size={22} className="np-like" />
          </div>
          <div className="np-progress"><SectionStrip /><Progress /></div>
          <div className="np-controls">
            <button className={`icon-btn ${shuffle ? 'on' : ''}`} aria-label="Shuffle" aria-pressed={shuffle} onClick={() => player().toggleShuffle()}><Icon name="shuffle" size={21} /></button>
            <motion.button whileTap={{ scale: 0.85 }} className="np-skip" aria-label="Previous" onClick={() => player().prev(useProgress.getState().position)}><Icon name="prevFill" size={34} /></motion.button>
            <motion.button whileTap={{ scale: 0.88 }} className="np-play" aria-label={playing ? 'Pause' : 'Play'} onClick={() => player().toggle()}>
              {buffering ? <Spinner size={30} /> : <PlayPauseIcon playing={playing} size={40} />}
            </motion.button>
            <motion.button whileTap={{ scale: 0.85 }} className="np-skip" aria-label="Next" onClick={() => player().next()}><Icon name="nextFill" size={34} /></motion.button>
            <button className={`icon-btn ${repeat !== 'off' ? 'on' : ''}`} aria-label={`Repeat ${repeat}`} onClick={() => player().cycleRepeat()}>
              <Icon name="repeat" size={21} />{repeat === 'one' && <span className="rep1">1</span>}
            </button>
          </div>
          <div className="np-extras">
            <VolumeSlider />
            <div className="row" style={{ gap: 2 }}>
              <button className={`icon-btn ${panel === 'lyrics' ? 'on' : ''}`} aria-label="Lyrics" onClick={() => player().setPanel('lyrics')}><Icon name="lyrics" size={20} /></button>
              <button className={`icon-btn ${panel === 'queue' ? 'on' : ''}`} aria-label="Up next" onClick={() => player().setPanel('queue')}><Icon name="queue" size={20} /></button>
              <ChorusButton />
              <button className="icon-btn" aria-label="Sleep timer" onClick={() => setSleepOpen(true)}><Icon name="moon" size={19} /></button>
              <button className="icon-btn" aria-label={`Speed ${rate}×`} title="Playback speed" onClick={() => { const rates = [1, 1.25, 1.5, 0.75]; player().setRate(rates[(rates.indexOf(rate) + 1) % rates.length]) }}>
                {rate === 1 ? <Icon name="speed" size={19} /> : <span style={{ fontSize: 12, fontWeight: 700 }}>{rate}×</span>}
              </button>
            </div>
          </div>
          <div className="np-foot">
            <ListenersPill />
            <RoomReactBar />
            <SleepBadge />
            {upNext && !split && (
              <button className="np-upnext glass-thin" onClick={() => player().setPanel('queue')}>
                <span className="t-eyebrow" style={{ color: 'rgba(255,255,255,.55)' }}>Up next{moodPick.trackId === upNext.id && moodPick.why ? ` · ${moodPick.why}` : ''}</span>
                <span className="ellipsis">{upNext.title} · <span style={{ opacity: 0.65 }}>{upNext.artist}</span></span>
              </button>
            )}
          </div>
          <IssueCard />
        </section>

        <AnimatePresence>
          {panel && (
            <motion.aside
              key={panel}
              className="np-panel"
              initial={{ opacity: 0, x: desktop ? 40 : 0, y: desktop ? 0 : 40 }}
              animate={{ opacity: 1, x: 0, y: 0 }}
              exit={{ opacity: 0, x: desktop ? 40 : 0, y: desktop ? 0 : 30 }}
              transition={spring}
            >
              {!desktop && (
                <div className="np-panel-mini">
                  <Artwork src={artworkFor(track, 'sm')} className="np-panel-art" />
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="ellipsis" style={{ fontWeight: 650 }}>{track.title}</div>
                    <div className="ellipsis" style={{ opacity: 0.65, fontSize: 13 }}>{track.artist}</div>
                  </div>
                  <button className="icon-btn" onClick={() => player().toggle()} aria-label={playing ? 'Pause' : 'Play'}><PlayPauseIcon playing={playing} /></button>
                  <button className="icon-btn" onClick={() => player().setPanel(null)} aria-label="Close panel"><Icon name="close" size={20} /></button>
                </div>
              )}
              {panel === 'lyrics' ? <LyricsPanel size={desktop ? 'lg' : 'md'} /> : <QueuePanel />}
            </motion.aside>
          )}
        </AnimatePresence>
      </div>
      <SleepSheet open={sleepOpen} onClose={() => setSleepOpen(false)} />
    </motion.div>
  )
}
