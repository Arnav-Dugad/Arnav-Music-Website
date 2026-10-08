import { motion, AnimatePresence } from 'motion/react'
import { useEffect, useState } from 'react'
import { Icon } from './Icon'
import { Artwork, spring } from './ui'
import { Progress, VolumeSlider } from './Progress'
import { LikeButton, openTrackMenu } from './TrackRow'
import { usePlayer, player, useProgress } from '../state/player'
import { useLyrics } from '../state/lyrics'
import { useSettings } from '../state/settings'
import { activeIndex } from '../lib/lyrics'
import { artworkFor } from '../lib/classify'
import { openPopOut, popOutSupported } from './PopOut'
import { Waveform, WaveTimes } from './Waveform'
import { automixStyle } from '../player/controller'
import type { PlayerBarPreset } from '../state/settings'

const PRESETS: PlayerBarPreset[] = ['compact', 'wide', 'studio']
const PRESET_LABEL: Record<PlayerBarPreset, string> = { compact: 'Compact', wide: 'Wide', studio: 'Studio' }
const AUTOMIX_LABEL = { off: 'Automix off', gapless: 'Gapless', crossfade: 'Crossfade', smart: 'Smart automix' } as const

// Play and pause drawn with the same commands (two quads each), so the shapes morph into each other.
const PAUSE_D = 'M6.6 4.8 L10.4 4.8 L10.4 19.2 L6.6 19.2 Z M13.6 4.8 L17.4 4.8 L17.4 19.2 L13.6 19.2 Z'
const PLAY_D = 'M7.6 4.6 L13.2 8.3 L13.2 15.7 L7.6 19.4 Z M13.2 8.3 L19.2 12 L19.2 12 L13.2 15.7 Z'

/** A play/pause glyph that morphs between shapes (the app's morphing play button). */
export function PlayPauseIcon({ playing, size = 22 }: { playing: boolean; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden style={{ flex: 'none', overflow: 'visible' }}>
      <motion.path
        initial={false}
        animate={{ d: playing ? PAUSE_D : PLAY_D }}
        transition={{ type: 'spring', stiffness: 520, damping: 32 }}
        fill="currentColor"
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** The line being sung, under the title (the app's mini-player lyrics). */
function LiveLyric() {
  const lyrics = useLyrics((s) => (s.status === 'found' ? s.lyrics : null))
  const enabled = useSettings((s) => s.miniPlayerLyrics)
  const [line, setLine] = useState<string | null>(null)
  useEffect(() => {
    if (!enabled || !lyrics || lyrics.kind !== 'synced') { setLine(null); return }
    const lines = lyrics.lines
    return useProgress.subscribe((s) => {
      const i = activeIndex(lines, s.position + 150)
      const text = i >= 0 ? lines[i].text || null : null
      setLine((prev) => (prev === text ? prev : text))
    })
  }, [lyrics, enabled])
  return (
    <AnimatePresence mode="wait" initial={false}>
      {line && (
        <motion.div key={line} className="pb-lyric ellipsis" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.25 }}>
          {line}
        </motion.div>
      )}
    </AnimatePresence>
  )
}

export function PreviewPill() {
  const t = usePlayer((s) => s.previewing)
  return (
    <AnimatePresence>
      {t && (
        <motion.div className="preview-pill glass-thick" initial={{ opacity: 0, y: 12, scale: 0.95 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 8 }} transition={{ type: 'spring', stiffness: 500, damping: 34 }}>
          <span className="eq"><i /><i /><i /></span> Previewing <b className="ellipsis">{t.title}</b> · release to return
        </motion.div>
      )}
    </AnimatePresence>
  )
}

export function PlayerBar() {
  const track = usePlayer((s) => s.queue[s.index]?.track ?? null)
  const playing = usePlayer((s) => s.wantPlaying)
  const buffering = usePlayer((s) => s.isBuffering && s.wantPlaying)
  const expanded = usePlayer((s) => s.expanded)
  const shuffle = usePlayer((s) => s.shuffle)
  const repeat = usePlayer((s) => s.repeat)
  const panel = usePlayer((s) => s.panel)
  const docked = useSettings((s) => s.dockedPlayer)
  const preset = useSettings((s) => s.playerBar)
  useSettings((s) => [s.gapless, s.crossfadeMs, s.smartTransitions].join())
  if (!track) return null
  const nextPreset = PRESETS[(PRESETS.indexOf(preset) + 1) % PRESETS.length]
  const open = (p?: 'lyrics' | 'queue') => {
    player().setExpanded(true)
    if (p && player().panel !== p) player().setPanel(p)
  }
  return (
    <motion.div className={`pbar glass-thick preset-${preset}`} initial={{ y: 120, opacity: 0 }} animate={{ y: expanded ? 140 : 0, opacity: expanded ? 0 : 1 }} transition={spring}>
      <div className="pb-left">
        <button className="pb-art" onClick={() => open()} aria-label="Open Now Playing">
          {!expanded ? (
            <motion.div layoutId="np-art" className="pb-art-inner" transition={spring}>
              <Artwork src={artworkFor(track)} seed={track.artist} />
            </motion.div>
          ) : <div className="pb-art-inner" />}
          <span className="pb-art-hover"><Icon name="chevronUp" size={18} /></span>
        </button>
        <div className="pb-meta" onClick={() => open()}>
          <div className="pb-title ellipsis">{track.title}</div>
          <div className="pb-sub ellipsis">{track.artist}</div>
          <LiveLyric />
        </div>
        <LikeButton track={track} />
      </div>
      <div className="pb-center">
        <div className="pb-controls">
          <button className={`icon-btn sm ${shuffle ? 'on' : ''}`} aria-label="Shuffle" aria-pressed={shuffle} onClick={() => player().toggleShuffle()}><Icon name="shuffle" size={17} /></button>
          <button className="icon-btn" aria-label="Previous" onClick={() => player().prev(useProgress.getState().position)}><Icon name="prevFill" size={20} /></button>
          <button className="pb-play" aria-label={playing ? 'Pause' : 'Play'} onClick={() => player().toggle()}>
            {buffering ? <span className="spinner" style={{ width: 20, height: 20, borderTopColor: 'var(--bg)' }} /> : <PlayPauseIcon playing={playing} size={20} />}
          </button>
          <button className="icon-btn" aria-label="Next" onClick={() => player().next()}><Icon name="nextFill" size={20} /></button>
          <button className={`icon-btn sm ${repeat !== 'off' ? 'on' : ''}`} aria-label={`Repeat ${repeat}`} onClick={() => player().cycleRepeat()}>
            <Icon name="repeat" size={17} />
            {repeat === 'one' && <span className="rep1">1</span>}
          </button>
        </div>
        {preset === 'studio' ? <div className="pb-wave"><Waveform track={track} /><WaveTimes /></div> : <Progress variant="bar" />}
      </div>
      <div className="pb-right">
        <button className={`icon-btn sm dock-dup ${panel === 'lyrics' && expanded ? 'on' : ''}`} aria-label="Lyrics" onClick={() => open('lyrics')}><Icon name="lyrics" size={18} /></button>
        <button className={`icon-btn sm dock-dup ${panel === 'queue' && expanded ? 'on' : ''}`} aria-label="Queue" onClick={() => open('queue')}><Icon name="queue" size={18} /></button>
        {preset === 'studio' && <span className="pb-automix t-caption" title="How songs hand over (Settings → Playback, or per playlist)"><Icon name="wave" size={14} /> {AUTOMIX_LABEL[automixStyle()]}</span>}
        {preset !== 'compact' && <VolumeSlider />}
        {popOutSupported() && <button className="icon-btn sm" aria-label="Pop out mini player" title="Pop out mini player" onClick={() => void openPopOut()}><Icon name="minimize" size={17} /></button>}
        <button className={`icon-btn sm ${docked ? 'on' : ''}`} aria-label={docked ? 'Undock Now Playing' : 'Dock Now Playing beside the page'} title="Dock Now Playing" onClick={() => useSettings.getState().update({ dockedPlayer: !docked })}><Icon name="dock" size={18} /></button>
        <button className="icon-btn sm" aria-label={`Player bar: ${PRESET_LABEL[preset]} (switch to ${PRESET_LABEL[nextPreset]})`} title={`Player bar: ${PRESET_LABEL[preset]} — switch to ${PRESET_LABEL[nextPreset]}`} onClick={() => useSettings.getState().update({ playerBar: nextPreset })}><Icon name={preset === 'studio' ? 'wave' : preset === 'compact' ? 'minus' : 'grid'} size={17} /></button>
        <button className="icon-btn sm" aria-label="More" onClick={(e) => openTrackMenu(e, track)}><Icon name="more" size={18} /></button>
      </div>
    </motion.div>
  )
}

/** Mobile mini player — floats above the tab bar; swipe up or tap to open. */
export function MiniPlayer() {
  const track = usePlayer((s) => s.queue[s.index]?.track ?? null)
  const playing = usePlayer((s) => s.wantPlaying)
  const expanded = usePlayer((s) => s.expanded)
  if (!track) return null
  return (
    <motion.div
      className="mini glass-thick"
      initial={{ y: 100, opacity: 0 }}
      animate={{ y: expanded ? 100 : 0, opacity: expanded ? 0 : 1 }}
      transition={spring}
      drag="y"
      dragConstraints={{ top: 0, bottom: 0 }}
      dragElastic={0.25}
      onDragEnd={(_, info) => { if (info.offset.y < -30 || info.velocity.y < -300) player().setExpanded(true) }}
      onClick={() => player().setExpanded(true)}
    >
      <div className="mini-art">
        {!expanded ? (
          <motion.div layoutId="np-art" className="pb-art-inner" transition={spring}><Artwork src={artworkFor(track)} seed={track.artist} /></motion.div>
        ) : <div className="pb-art-inner" />}
      </div>
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="pb-title ellipsis">{track.title}</div>
        <div className="pb-sub ellipsis">{track.artist}</div>
      </div>
      <button className="icon-btn" aria-label={playing ? 'Pause' : 'Play'} onClick={(e) => { e.stopPropagation(); player().toggle() }}>
        <PlayPauseIcon playing={playing} size={24} />
      </button>
      <button className="icon-btn" aria-label="Next" onClick={(e) => { e.stopPropagation(); player().next() }}><Icon name="nextFill" size={22} /></button>
      <div className="mini-prog"><Progress variant="line" /></div>
    </motion.div>
  )
}
