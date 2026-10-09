/**
 * A public playlist (`/p/<id>`): someone's playlist shared as a link. Anyone can open it, play it,
 * and save a copy to their own library — no account or Friends profile needed to listen.
 */
import { useMemo } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { motion } from 'motion/react'
import { Empty, Notice, SkeletonRows, Spinner } from '../components/ui'
import { Icon } from '../components/Icon'
import { TrackList } from '../components/TrackRow'
import { Avatar } from '../components/Social'
import { useAsync, usePaletteFor, usePageTheme } from '../hooks'
import { longDuration, relative } from '../lib/format'
import { artworkFor } from '../lib/classify'
import { lib } from '../state/library'
import { player } from '../state/player'
import { toast } from '../state/ui'
import { asTrack, markSaved, publicLink, publicPlaylist, SocialError, useSocial } from '../services/social'

export default function PublicPlaylistPage() {
  const { id = '' } = useParams()
  const nav = useNavigate()
  const res = useAsync(() => publicPlaylist(id.toUpperCase()), [id])
  const meId = useSocial((s) => s.me?.id ?? null)
  const data = res.data
  const tracks = useMemo(() => (data ? data.playlist.tracks.map(asTrack) : []), [data])
  const cover = data?.playlist.art ?? (tracks[0] ? artworkFor(tracks[0]) : null)
  const palette = usePaletteFor(cover)
  usePageTheme(palette)

  if (res.loading && !data) return <div className="page"><div style={{ height: 320 }} /><SkeletonRows n={10} /></div>
  if (!data) {
    const gone = res.error instanceof SocialError && res.error.status === 404
    return (
      <div className="page">
        <Empty icon="note" title={gone ? 'This playlist isn’t public any more' : 'Couldn’t open this playlist'}
          body={gone ? 'Its owner made it private or deleted it.' : 'Check your connection and try again.'}
          action={gone ? <button className="btn btn-secondary" onClick={() => nav('/')}>Go home</button> : <button className="btn btn-secondary" onClick={res.reload}>Try again</button>} />
      </div>
    )
  }
  const { playlist, owner } = data
  const mine = owner.id === meId
  const total = tracks.reduce((a, t) => a + (t.durationMs ?? 0), 0)
  const context = `${playlist.title} · ${owner.name}`
  const save = () => {
    const nid = lib().createPlaylist(playlist.title, tracks, playlist.description ?? `Shared by ${owner.name}`)
    markSaved(playlist.id)
    toast('Saved to your playlists', { label: 'Open', run: () => nav(`/playlist/${nid}`) })
  }
  const share = async () => {
    const url = publicLink(playlist.id)
    if (navigator.share && matchMedia('(pointer: coarse)').matches) { try { await navigator.share({ title: playlist.title, url }); return } catch { /* cancelled */ } }
    await navigator.clipboard?.writeText(url).catch(() => undefined)
    toast('Link copied')
  }

  return (
    <div className="page playlist-page">
      <div className="pl-tint" style={{ ['--t1' as string]: palette.bg[0], ['--t2' as string]: palette.vivid }} />
      <header className="pl-hero">
        <motion.div className="hero-cover" initial={{ opacity: 0, scale: 0.94 }} animate={{ opacity: 1, scale: 1 }} transition={{ type: 'spring', stiffness: 260, damping: 26 }}>
          <div className="hero-cover-inner"><img src={cover ?? ''} alt="" className="hero-img" /></div>
        </motion.div>
        <div className="pl-hero-text">
          <div className="t-eyebrow"><span className="pl-public-badge"><Icon name="globe" size={12} /> Public playlist</span></div>
          <h1 className="t-hero pl-title">{playlist.title}</h1>
          {playlist.description && <p className="t-sub pl-desc clamp-2">{playlist.description}</p>}
          <button className="pub-owner" onClick={() => nav(`/u/${owner.handle}`)}>
            <Avatar p={owner} size={26} />
            <span><b>{owner.name}</b> <span className="t-caption">@{owner.handle}</span></span>
          </button>
          <div className="t-caption" style={{ marginTop: 8 }}>{playlist.count} songs{total ? ` · ${longDuration(total)}` : ''} · updated {relative(playlist.updated)}{playlist.saves ? ` · saved by ${playlist.saves}` : ''}</div>
          <div className="row pl-actions">
            <motion.button whileTap={{ scale: 0.95 }} className="btn btn-primary btn-lg" disabled={!tracks.length} onClick={() => player().play(tracks, 0, { context, shuffle: false })}><Icon name="play" size={16} /> Play</motion.button>
            <motion.button whileTap={{ scale: 0.95 }} className="btn btn-secondary btn-lg" disabled={!tracks.length} onClick={() => player().play(tracks, Math.floor(Math.random() * tracks.length), { context, shuffle: true })}><Icon name="shuffle" size={16} /> Shuffle</motion.button>
            {!mine && <button className="btn btn-secondary" onClick={save}><Icon name="plus" size={16} /> Save</button>}
            <button className="icon-btn" aria-label="Share" title="Share" onClick={() => void share()}><Icon name="share" size={18} /></button>
            {res.loading && <Spinner size={16} />}
          </div>
        </div>
      </header>
      <section className="section" style={{ marginTop: 28 }}>
        {mine && <Notice tone="info">This is your public playlist — edit it in your library and the link updates.</Notice>}
        {tracks.length ? <TrackList tracks={tracks} context={context} /> : <Empty icon="note" title="This playlist is empty" />}
      </section>
    </div>
  )
}
