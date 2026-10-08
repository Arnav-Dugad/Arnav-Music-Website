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

export function PlayPauseIcon({ playing, size = 22 }: { playing: boolean; size?: number }) {
  return (
    <AnimatePresence mode="popLayout" initial={false}>
      <motion.span
        key={playing ? 'pause' : 'play'}
        initial={{ scale: 0.4, opacity: 0, rotate: playing ? -30 : 30 }}
        animate={{ scale: 1, opacity: 1, rotate: 0 }}
        exit={{ scale: 0.4, opacity: 0 }}
        transition={{ type: 'spring', stiffness: 600, damping: 30 }}
        style={{ display: 'grid', placeItems: 'center' }}
      >
        <Icon name={playing ? 'pause' : 'play'} size={size} style={playing ? undefined : { marginLeft: size * 0.08 }} />
      </motion.span>
    </AnimatePresence>
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

export function PlayerBar() {
  const track = usePlayer((s) => s.queue[s.index]?.track ?? null)
  const playing = usePlayer((s) => s.wantPlaying)
  const buffering = usePlayer((s) => s.isBuffering && s.wantPlaying)
  const expanded = usePlayer((s) => s.expanded)
  const shuffle = usePlayer((s) => s.shuffle)
  const repeat = usePlayer((s) => s.repeat)
  const panel = usePlayer((s) => s.panel)
  if (!track) return null
  const open = (p?: 'lyrics' | 'queue') => {
    player().setExpanded(true)
    if (p && player().panel !== p) player().setPanel(p)
  }
  return (
    <motion.div className="pbar glass-thick" initial={{ y: 120, opacity: 0 }} animate={{ y: expanded ? 140 : 0, opacity: expanded ? 0 : 1 }} transition={spring}>
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
        <Progress variant="bar" />
      </div>
      <div className="pb-right">
        <button className={`icon-btn sm ${panel === 'lyrics' && expanded ? 'on' : ''}`} aria-label="Lyrics" onClick={() => open('lyrics')}><Icon name="lyrics" size={18} /></button>
        <button className={`icon-btn sm ${panel === 'queue' && expanded ? 'on' : ''}`} aria-label="Queue" onClick={() => open('queue')}><Icon name="queue" size={18} /></button>
        <VolumeSlider />
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
