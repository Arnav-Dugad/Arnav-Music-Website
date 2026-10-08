import { useEffect } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Icon } from './Icon'
import { Artwork } from './ui'
import { LyricsPanel } from './Lyrics'
import { PlayPauseIcon } from './PlayerBar'
import { useLyrics } from '../state/lyrics'
import { player, usePlayer, useProgress } from '../state/player'
import { artworkFor } from '../lib/classify'

/** Cinematic lyrics: full screen, large serif type over the blurred cover. Esc or C to leave. */
export function CinematicLyrics() {
  const open = useLyrics((s) => s.cinematic)
  const track = usePlayer((s) => s.queue[s.index]?.track ?? null)
  const playing = usePlayer((s) => s.wantPlaying)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea, select')) return
      if (e.key === 'Escape' && useLyrics.getState().cinematic) { e.stopPropagation(); useLyrics.getState().set({ cinematic: false }) }
      if ((e.key === 'c' || e.key === 'C') && !e.metaKey && !e.ctrlKey) useLyrics.getState().set({ cinematic: !useLyrics.getState().cinematic })
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
  useEffect(() => {
    if (!open) return
    document.documentElement.requestFullscreen?.().catch(() => undefined)
    return () => { if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined) }
  }, [open])
  return (
    <AnimatePresence>
      {open && track && (
        <motion.div className="cine" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.5 }}>
          <div className="cine-bg">
            <AnimatePresence initial={false}>
              <motion.img key={track.id} src={artworkFor(track)} alt="" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 1.4 }} />
            </AnimatePresence>
          </div>
          <div className="cine-top">
            <Artwork src={artworkFor(track, 'sm')} className="cine-art" letterbox={false} />
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="ellipsis" style={{ fontWeight: 700, fontSize: 16 }}>{track.title}</div>
              <div className="ellipsis" style={{ opacity: 0.7, fontSize: 14 }}>{track.artist}</div>
            </div>
            <button className="icon-btn" aria-label="Previous" onClick={() => player().prev(useProgress.getState().position)}><Icon name="prevFill" size={20} /></button>
            <button className="icon-btn lg" aria-label={playing ? 'Pause' : 'Play'} onClick={() => player().toggle()}><PlayPauseIcon playing={playing} size={26} /></button>
            <button className="icon-btn" aria-label="Next" onClick={() => player().next()}><Icon name="nextFill" size={20} /></button>
            <button className="icon-btn" aria-label="Leave cinematic lyrics" onClick={() => useLyrics.getState().set({ cinematic: false })}><Icon name="minimize" size={20} /></button>
          </div>
          <div className="cine-body"><LyricsPanel size="xl" /></div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
