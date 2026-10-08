import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Icon } from './Icon'
import { Artwork, Segmented, spring } from './ui'
import { LyricsPanel } from './Lyrics'
import { QueuePanel } from './Queue'
import { ArtistLinks, LikeButton } from './TrackRow'
import { usePlayer, player } from '../state/player'
import { useSettings } from '../state/settings'
import { useIsDesktop } from '../hooks'
import { artworkFor } from '../lib/classify'
import { useLyrics } from '../state/lyrics'

/** Desktop: Now Playing docked beside your page — cover, credits, lyrics and the queue. */
export function DockPanel() {
  const docked = useSettings((s) => s.dockedPlayer)
  const desktop = useIsDesktop()
  const track = usePlayer((s) => s.queue[s.index]?.track ?? null)
  const expanded = usePlayer((s) => s.expanded)
  const [tab, setTab] = useState<'lyrics' | 'queue'>('lyrics')
  const show = docked && desktop && !!track && !expanded
  const sidebar = useLyrics((s) => s.sidebar) && tab === 'lyrics'
  // The wide lyrics sidebar takes room from the page (the layout reads --dock).
  useEffect(() => {
    const root = document.documentElement
    if (show && sidebar) root.style.setProperty('--dock', 'min(620px, 46vw)')
    else root.style.removeProperty('--dock')
    return () => { root.style.removeProperty('--dock') }
  }, [show, sidebar])
  return (
    <AnimatePresence>
      {show && track && (
        <motion.aside className={`dock ${sidebar ? 'wide' : ''}`} initial={{ x: 420, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: 420, opacity: 0 }} transition={spring} aria-label="Now Playing">
          <div className="dock-bg living"><div className="blob b1" /><div className="blob b2" /><div className="blob b3" /></div>
          <div className="dock-inner">
            <div className="dock-head">
              <span className="t-eyebrow" style={{ color: 'rgba(255,255,255,.6)' }}>Now playing</span>
              <span className="grow" />
              <button className={`icon-btn sm ${sidebar ? 'on' : ''}`} aria-label={sidebar ? 'Narrow dock' : 'Lyrics sidebar with translation'} title="Lyrics sidebar" onClick={() => { setTab('lyrics'); useLyrics.getState().set({ sidebar: !useLyrics.getState().sidebar, showTranslation: true }) }}><Icon name="translate" size={16} /></button>
              <button className="icon-btn sm" aria-label="Open full screen" onClick={() => player().setExpanded(true)}><Icon name="expand" size={16} /></button>
              <button className="icon-btn sm" aria-label="Undock" onClick={() => useSettings.getState().update({ dockedPlayer: false })}><Icon name="close" size={16} /></button>
            </div>
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.div key={track.id} className="dock-art" initial={{ opacity: 0, scale: 0.94, filter: 'blur(8px)' }} animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }} exit={{ opacity: 0, scale: 0.96 }} transition={{ duration: 0.45 }}>
                <Artwork src={artworkFor(track)} seed={track.artist} hi eager />
              </motion.div>
            </AnimatePresence>
            <div className="dock-meta">
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="dock-title ellipsis">{track.title}</div>
                <div className="dock-artist ellipsis"><ArtistLinks track={track} /></div>
              </div>
              <LikeButton track={track} size={20} />
            </div>
            <div className="dock-tabs"><Segmented id="dock-tab" size="sm" value={tab} onChange={setTab} options={[{ value: 'lyrics', label: 'Lyrics' }, { value: 'queue', label: 'Up next' }]} /></div>
            <div className="dock-panel">{tab === 'lyrics' ? <LyricsPanel size="md" dual={sidebar} /> : <QueuePanel />}</div>
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  )
}
