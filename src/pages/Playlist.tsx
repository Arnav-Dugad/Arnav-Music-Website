import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { motion, Reorder, useScroll, useTransform } from 'motion/react'
import { Empty, Notice, Sheet, SkeletonRows, Spinner } from '../components/ui'
import { Icon } from '../components/Icon'
import { TrackList, TrackRow } from '../components/TrackRow'
import { MixArt } from '../components/Mix'
import { PlaylistThumb } from '../components/Shell'
import { useAsync, usePaletteFor, usePageTheme, useRegistryVersion } from '../hooks'
import { playlistInfo, playlistTracks } from '../lib/youtube'
import { SMART, smartPlaylist, type SmartKind } from '../lib/taste'
import { longDuration, relative } from '../lib/format'
import { artworkFor } from '../lib/classify'
import { findLyricsCandidates } from '../services/lyricsEngine'
import { AutomixPicker } from '../components/AutomixPicker'
import { MusicError, type Track } from '../lib/types'
import { likedIds, likedTracks, liveEvents, useLibrary, lib } from '../state/library'
import { trackRegistry } from '../state/tracks'
import { player } from '../state/player'
import { toast } from '../state/ui'
import { dailyMixes } from '../services/recs'
import { namePlaylist } from '../lib/aiFeatures'

interface View {
  kind: 'liked' | 'local' | 'smart' | 'daily' | 'remote'
  title: string
  description?: string
  tracks: Track[]
  art?: React.ReactNode
  artUrl?: string | null
  meta?: string
  editable?: boolean
}


export default function PlaylistPage() {
  const { id = '' } = useParams()
  const [params, setParams] = useSearchParams()
  const nav = useNavigate()
  const v = useRegistryVersion()
  const playlists = useLibrary((s) => s.playlists)
  const likes = useLibrary((s) => s.likes)
  const events = useLibrary((s) => s.events)
  const savedRemote = useLibrary((s) => s.savedRemote)
  const [editOpen, setEditOpen] = useState(params.get('edit') === '1')
  const [reordering, setReordering] = useState(false)
  const [lyricsJob, setLyricsJob] = useState<{ done: number; total: number } | null>(null)
  const scrollRef = useRef<HTMLElement | null>(document.querySelector<HTMLElement>('.main-scroll'))
  const { scrollY } = useScroll({ container: scrollRef })
  const coverScale = useTransform(scrollY, [0, 260], [1, 0.82])
  const coverY = useTransform(scrollY, [0, 260], [0, 40])
  const heroOpacity = useTransform(scrollY, [0, 240], [1, 0.35])

  const remoteId = id.startsWith('ytpl:') ? id.slice(5) : null
  const remote = useAsync(() => (remoteId ? Promise.all([playlistInfo(remoteId), playlistTracks(remoteId)]) : Promise.resolve(null)), [remoteId])

  const view = useMemo<View | null>(() => {
    if (id === 'liked') {
      const tracks = likedTracks(likes)
      return { kind: 'liked', title: 'Liked Songs', tracks, art: <div className="liked-art hero-cover-inner"><Icon name="heartFill" size={72} /></div>, meta: 'Syncs with your phone' }
    }
    if (id.startsWith('smart:')) {
      const k = id.slice(6) as SmartKind
      if (!SMART[k]) return null
      const tracks = trackRegistry.many(smartPlaylist(k, liveEvents(events), likedIds(likes)))
      return { kind: 'smart', title: SMART[k].title, description: SMART[k].blurb, tracks, art: <MixArt title={SMART[k].title} hue={SMART[k].hue} tracks={tracks} />, meta: 'Smart playlist · updates as you listen' }
    }
    if (id.startsWith('daily:')) {
      const d = dailyMixes().find((m) => m.id === `daily_${id.slice(6)}`)
      if (!d) return null
      return { kind: 'daily', title: d.title, description: d.artists.join(', '), tracks: d.tracks, art: <MixArt title={d.title} eyebrow="Daily" hue={d.hue} tracks={d.tracks} />, meta: 'Made for you today' }
    }
    if (remoteId) {
      const [info, tracks] = remote.data ?? [null, null]
      return { kind: 'remote', title: info?.name ?? 'YouTube playlist', description: info?.owner, tracks: tracks ?? [], artUrl: info?.artworkUrl ?? (tracks?.[0] ? artworkFor(tracks[0]) : null), meta: 'YouTube playlist' }
    }
    const p = playlists[id]
    if (!p || p.deleted) return null
    const tracks = trackRegistry.many(p.trackIds)
    return {
      kind: 'local', title: p.name, description: p.description, tracks,
      art: <PlaylistThumb artwork={p.artworkUrl} trackIds={p.trackIds} name={p.name} size="lg" />,
      meta: `${p.remoteRef ? 'Imported from YouTube · ' : ''}Updated ${relative(p.updatedAt)}`, editable: true,
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, playlists, likes, events, v, remote.data, remoteId])

  const coverUrl = view?.artUrl ?? (view?.tracks[0] ? artworkFor(view.tracks[0]) : null)
  const palette = usePaletteFor(coverUrl)
  usePageTheme(palette)

  if (!view) {
    if (remoteId && remote.loading) return <div className="page"><div style={{ height: 320 }} /><SkeletonRows n={10} /></div>
    return <div className="page"><Empty icon="note" title="Playlist not found" body="It may have been deleted on another device." action={<button className="btn btn-secondary" onClick={() => nav('/library')}>Go to Library</button>} /></div>
  }
  const total = view.tracks.reduce((a, t) => a + (t.durationMs ?? 0), 0)
  const p = view.kind === 'local' ? playlists[id] : null
  const isSaved = remoteId ? savedRemote.some((x) => x.id === id) : false

  const downloadLyrics = async () => {
    const list = view.tracks.slice(0, 300)
    setLyricsJob({ done: 0, total: list.length })
    let found = 0
    for (let i = 0; i < list.length; i++) {
      try { const r = await findLyricsCandidates(list[i]); if (r.status === 'found') found++ } catch { /* keep going */ }
      setLyricsJob({ done: i + 1, total: list.length })
      await new Promise((r) => setTimeout(r, 250))
    }
    setLyricsJob(null)
    toast(`Lyrics saved for ${found} of ${list.length} songs`)
  }

  return (
    <div className="page playlist-page">
      <div className="pl-tint" style={{ ['--t1' as string]: palette.bg[0], ['--t2' as string]: palette.vivid }} />
      <motion.header className="pl-hero" style={{ opacity: heroOpacity }}>
        <motion.div className="hero-cover" style={{ scale: coverScale, y: coverY, viewTransitionName: 'cover' }}>
          {view.art ?? <div className="hero-cover-inner"><img src={coverUrl ?? ''} alt="" className="hero-img" /></div>}
        </motion.div>
        <div className="pl-hero-text">
          <div className="t-eyebrow">{view.kind === 'remote' ? <span className="badge yt"><Icon name="youtube" size={11} /> YouTube</span> : view.kind === 'smart' || view.kind === 'daily' ? <span className="badge ai">Made for you</span> : 'Playlist'}</div>
          <h1 className="t-hero pl-title">{view.title}</h1>
          {view.description && <p className="t-sub pl-desc clamp-2">{view.description}</p>}
          <div className="t-caption" style={{ marginTop: 8 }}>{view.tracks.length} songs{total ? ` · ${longDuration(total)}` : ''}{view.meta ? ` · ${view.meta}` : ''}</div>
          <div className="row pl-actions">
            <motion.button whileTap={{ scale: 0.95 }} className="btn btn-primary btn-lg" disabled={!view.tracks.length} onClick={() => player().play(view.tracks, 0, { context: view.title, contextId: id, shuffle: false })}><Icon name="play" size={16} /> Play</motion.button>
            <motion.button whileTap={{ scale: 0.95 }} className="btn btn-secondary btn-lg" disabled={!view.tracks.length} onClick={() => player().play(view.tracks, Math.floor(Math.random() * view.tracks.length), { context: view.title, contextId: id, shuffle: true })}><Icon name="shuffle" size={16} /> Shuffle</motion.button>
            {view.tracks.length > 1 && <AutomixPicker id={id} />}
            <button className="icon-btn" aria-label="Add all to queue" title="Add all to queue" disabled={!view.tracks.length} onClick={() => { player().addToQueue(view.tracks); toast(`Added ${view.tracks.length} songs to the queue`) }}><Icon name="queue" size={19} /></button>
            {view.kind !== 'local' && view.kind !== 'liked' && view.tracks.length > 0 && (
              <button className="icon-btn" aria-label="Copy to a new playlist" title="Copy to a new playlist" onClick={() => { const nid = lib().createPlaylist(view.title, view.tracks, view.description ?? ''); toast('Copied to your playlists', { label: 'Open', run: () => nav(`/playlist/${nid}`) }) }}><Icon name="plus" size={19} /></button>
            )}
            {remoteId && (
              <button className={`icon-btn ${isSaved ? 'on' : ''}`} aria-label={isSaved ? 'Remove from library' : 'Save to library'} title={isSaved ? 'Saved' : 'Save'} onClick={() => { lib().toggleSavedRemote({ id, name: view.title, owner: view.description ?? '', artworkUrl: coverUrl }); toast(isSaved ? 'Removed from your library' : 'Saved to your library') }}><Icon name={isSaved ? 'check' : 'download'} size={19} /></button>
            )}
            {p && <button className={`icon-btn ${p.pinned ? 'on' : ''}`} aria-label={p.pinned ? 'Unpin' : 'Pin'} title={p.pinned ? 'Unpin' : 'Pin to top'} onClick={() => lib().updatePlaylist(id, { pinned: !p.pinned })}><Icon name="pin" size={18} /></button>}
            {p && <button className="icon-btn" aria-label="Edit details" title="Edit details" onClick={() => setEditOpen(true)}><Icon name="edit" size={18} /></button>}
            {p && view.tracks.length > 1 && <button className={`icon-btn ${reordering ? 'on' : ''}`} aria-label="Reorder" title="Reorder songs" onClick={() => setReordering((r) => !r)}><Icon name="drag" size={18} /></button>}
            <button className="icon-btn" aria-label="Download lyrics" title="Download lyrics for offline" disabled={!!lyricsJob || !view.tracks.length} onClick={() => void downloadLyrics()}>{lyricsJob ? <Spinner size={16} /> : <Icon name="lyrics" size={18} />}</button>
            <button className="icon-btn" aria-label="Share" title="Copy link" onClick={() => { void navigator.clipboard?.writeText(location.href).then(() => toast('Link copied')) }}><Icon name="link" size={18} /></button>
          </div>
          {lyricsJob && <div className="t-caption" style={{ marginTop: 8 }}>Fetching lyrics {lyricsJob.done}/{lyricsJob.total}…</div>}
        </div>
      </motion.header>

      <section className="section" style={{ marginTop: 28 }}>
        {view.kind === 'remote' && remote.error ? (
          <Notice tone="warn">{remote.error instanceof MusicError ? remote.error.message : 'This playlist couldn’t load.'}</Notice>
        ) : view.kind === 'remote' && remote.loading && !view.tracks.length ? <SkeletonRows n={12} /> : view.tracks.length === 0 ? (
          <Empty icon="note" title={view.kind === 'liked' ? 'No liked songs yet' : view.kind === 'smart' ? 'Not enough listening yet' : 'This playlist is empty'}
            body={view.kind === 'local' ? 'Use “Add to playlist” on any song to fill it.' : view.kind === 'smart' ? 'Smart playlists fill themselves as you play music.' : undefined}
            action={view.kind === 'local' ? <button className="btn btn-secondary" onClick={() => nav('/explore')}><Icon name="search" size={15} /> Find songs</button> : undefined} />
        ) : reordering && p ? (
          <Reorder.Group axis="y" values={p.trackIds} onReorder={(ids) => lib().reorderPlaylist(id, ids)} as="div" className="track-list">
            {p.trackIds.map((tid, i) => {
              const t = trackRegistry.get(tid)
              if (!t) return null
              return (
                <Reorder.Item key={tid} value={tid} as="div" className="reorder-item" whileDrag={{ scale: 1.02, boxShadow: 'var(--shadow-2)', background: 'var(--surface-raised)', borderRadius: 12 }}>
                  <TrackRow track={t} index={i} list={view.tracks} context={view.title} number playlistId={id} right={<span className="q-handle"><Icon name="drag" size={16} /></span>} />
                </Reorder.Item>
              )
            })}
          </Reorder.Group>
        ) : (
          <TrackList tracks={view.tracks} context={view.title} playlistId={view.kind === 'local' ? id : undefined} />
        )}
      </section>

      {p && <EditSheet open={editOpen} onClose={() => { setEditOpen(false); if (params.get('edit')) setParams({}, { replace: true }) }} id={id} />}
    </div>
  )
}

function EditSheet({ open, onClose, id }: { open: boolean; onClose: () => void; id: string }) {
  const p = useLibrary((s) => s.playlists[id])
  const nav = useNavigate()
  const [name, setName] = useState(p?.name ?? '')
  const [desc, setDesc] = useState(p?.description ?? '')
  const [confirm, setConfirm] = useState(false)
  const [naming, setNaming] = useState(false)
  useEffect(() => { if (open && p) { setName(p.name); setDesc(p.description); setConfirm(false) } }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  const suggest = async () => {
    if (!p) return
    setNaming(true)
    try {
      const r = await namePlaylist(trackRegistry.many(p.trackIds))
      setName(r.name); setDesc(r.description)
      if (!r.usedAi) toast('Suggested on device')
    } finally { setNaming(false) }
  }
  if (!p) return null
  return (
    <Sheet open={open} onClose={onClose} title="Edit playlist" width={480}>
      <form className="col" style={{ gap: 12 }} onSubmit={(e) => { e.preventDefault(); lib().updatePlaylist(id, { name: name.trim() || p.name, description: desc }); onClose() }}>
        <label className="col" style={{ gap: 6 }}><span className="t-caption">Name</span><input className="field" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} autoFocus /></label>
        <button type="button" className="btn btn-secondary btn-sm" style={{ alignSelf: 'flex-start' }} disabled={naming || !p.trackIds.length} onClick={() => void suggest()}>{naming ? <Spinner size={13} /> : <Icon name="sparkles" size={14} />} Suggest a name and description</button>
        <label className="col" style={{ gap: 6 }}><span className="t-caption">Description</span><textarea className="field" rows={3} maxLength={500} value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Add an optional description" /></label>
        <div className="row" style={{ justifyContent: 'space-between', marginTop: 6 }}>
          {confirm ? (
            <button type="button" className="btn btn-danger" onClick={() => { lib().deletePlaylist(id); onClose(); toast('Playlist deleted'); nav('/library') }}><Icon name="trash" size={15} /> Delete for good</button>
          ) : (
            <button type="button" className="btn btn-ghost" onClick={() => setConfirm(true)}><Icon name="trash" size={15} /> Delete playlist</button>
          )}
          <div className="row">
            <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary">Save</button>
          </div>
        </div>
      </form>
      <div className="t-caption" style={{ marginTop: 14 }}>Changes sync to your phone when you’re signed in.</div>
    </Sheet>
  )
}
