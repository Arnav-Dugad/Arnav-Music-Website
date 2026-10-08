import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { motion } from 'motion/react'
import { Artwork, Spinner } from '../components/ui'
import { Icon } from '../components/Icon'
import { video } from '../lib/youtube'
import { artworkFor } from '../lib/classify'
import { MusicError, ytId, type Track } from '../lib/types'
import { trackRegistry } from '../state/tracks'
import { player } from '../state/player'
import { useSettings } from '../state/settings'

/** Shared links: /track/<videoId> (same id as the app's arnavmusic://track/<videoId>). */
export default function TrackLink() {
  const { videoId = '' } = useParams()
  const nav = useNavigate()
  const [track, setTrack] = useState<Track | null>(trackRegistry.get(ytId(videoId)) ?? null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) { setError('This link isn’t valid.'); return }
    if (track) return
    video(videoId).then(setTrack).catch((e) => setError(e instanceof MusicError ? e.message : 'This song couldn’t load.'))
  }, [videoId]) // eslint-disable-line react-hooks/exhaustive-deps
  const play = () => {
    if (!track) return
    if (!useSettings.getState().onboardingDone) useSettings.getState().update({ onboardingDone: true })
    player().play([track], 0, { context: 'Shared with you' })
    player().setExpanded(true)
    nav('/', { replace: true })
  }
  return (
    <div className="page center" style={{ minHeight: '80vh' }}>
      {error ? (
        <div className="empty"><div className="t-title">{error}</div><button className="btn btn-secondary" onClick={() => nav('/')}>Go home</button></div>
      ) : !track ? <Spinner size={28} /> : (
        <motion.div className="share-card glass-thick" initial={{ opacity: 0, y: 20, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ type: 'spring', stiffness: 220, damping: 24 }}>
          <Artwork src={artworkFor(track)} className="share-art" eager hi />
          <div className="t-eyebrow" style={{ marginTop: 18 }}>Shared with you</div>
          <div className="t-large" style={{ fontSize: 28 }}>{track.title}</div>
          <div className="t-sub">{track.artist}</div>
          <button className="btn btn-primary btn-lg" style={{ marginTop: 18 }} onClick={play}><Icon name="play" size={16} /> Play on Arnav Music</button>
        </motion.div>
      )}
    </div>
  )
}
