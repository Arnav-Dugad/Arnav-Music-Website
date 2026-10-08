import { useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { motion } from 'motion/react'
import { Card, Empty, PageHeader, Segmented, Artwork, Sheet } from '../components/ui'
import { Icon } from '../components/Icon'
import { TrackList } from '../components/TrackRow'
import { PlaylistThumb } from '../components/Shell'
import { YouTubeImport } from '../components/YouTubeImport'
import { useLiveHistory, useRegistryVersion } from '../hooks'
import { matchScore } from '../lib/query'
import { relative } from '../lib/format'
import { topArtists } from '../lib/taste'
import { artworkFor } from '../lib/classify'
import { likedTracks, liveEvents, useLibrary, visiblePlaylists } from '../state/library'
import { trackRegistry } from '../state/tracks'
import { useSettings } from '../state/settings'
import { player } from '../state/player'

type Tab = 'playlists' | 'songs' | 'artists' | 'history' | 'saved' | 'hidden'
const TABS: { value: Tab; label: string }[] = [
  { value: 'playlists', label: 'Playlists' }, { value: 'songs', label: 'Songs' }, { value: 'artists', label: 'Artists' },
  { value: 'history', label: 'History' }, { value: 'saved', label: 'Saved' }, { value: 'hidden', label: 'Hidden' },
]

export default function Library() {
  const { tab: tabParam } = useParams()
  const nav = useNavigate()
  const tab = (TABS.some((t) => t.value === tabParam) ? tabParam : 'playlists') as Tab
  const [q, setQ] = useState('')
  const [sort, setSort] = useState<'recent' | 'name' | 'count'>('recent')
  const [importOpen, setImportOpen] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const layout = useSettings((s) => s.libraryLayout)
  const playlists = useLibrary((s) => s.playlists)
  const likes = useLibrary((s) => s.likes)
  const events = useLibrary((s) => s.events)
  const saved = useLibrary((s) => s.savedRemote)
  const notInterested = useLibrary((s) => s.notInterested)
  const blocked = useLibrary((s) => s.blockedArtists)
  const v = useRegistryVersion()
  const history = useLiveHistory(300)

  const lists = useMemo(() => {
    let l = visiblePlaylists(playlists)
    if (q) l = l.filter((p) => matchScore(q, p.name) >= 0.5)
    if (sort === 'name') l = [...l].sort((a, b) => a.name.localeCompare(b.name))
    if (sort === 'count') l = [...l].sort((a, b) => b.trackIds.length - a.trackIds.length)
    return l
  }, [playlists, q, sort])
  const songs = useMemo(() => {
    const l = likedTracks(likes)
    return q ? l.filter((t) => Math.max(matchScore(q, t.title), matchScore(q, t.artist)) >= 0.55) : l
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [likes, q, v])
  const artists = useMemo(() => {
    const a = topArtists(liveEvents(events), (id) => trackRegistry.get(id))
    return q ? a.filter((x) => matchScore(q, x.name) >= 0.5) : a
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, q, v])
  const likedCount = useMemo(() => Object.values(likes).filter((l) => !l.deleted).length, [likes])

  return (
    <div className="page library">
      <PageHeader title="Library" actions={<>
        <button className="btn btn-secondary btn-sm" onClick={() => setImportOpen(true)}><Icon name="youtube" size={15} /> Import from YouTube</button>
        <button className="btn btn-primary btn-sm" onClick={() => { const id = useLibrary.getState().createPlaylist('New playlist'); nav(`/playlist/${id}?edit=1`) }}><Icon name="plus" size={15} /> New playlist</button>
      </>} />
      <div className="lib-bar">
        <div className="lib-tabs"><Segmented id="libtab" value={tab} onChange={(t) => nav(`/library/${t}`, { replace: true })} options={TABS} /></div>
        <div className="row" style={{ gap: 8 }}>
          <div className="mini-search">
            <Icon name="search" size={15} />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Filter ${tab}`} aria-label="Filter library" />
          </div>
          {tab === 'playlists' && (
            <>
              <select className="chip-select" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} aria-label="Sort">
                <option value="recent">Recent</option><option value="name">A–Z</option><option value="count">Most songs</option>
              </select>
              <button className="icon-btn sm" aria-label="Toggle layout" onClick={() => useSettings.getState().update({ libraryLayout: layout === 'grid' ? 'list' : 'grid' })}>
                <Icon name={layout === 'grid' ? 'list' : 'grid'} size={17} />
              </button>
            </>
          )}
        </div>
      </div>

      <motion.div key={tab} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }} className="section" style={{ marginTop: 22 }}>
        {tab === 'playlists' && (
          layout === 'grid' ? (
            <div className="grid-cards">
              <Card title="Liked Songs" subtitle={`${likedCount} songs`} custom={<div className="card-art liked-art"><Icon name="heartFill" size={44} /></div>} onOpen={() => nav('/playlist/liked')} onPlay={likedCount ? () => player().play(likedTracks(), 0, { context: 'Liked Songs' }) : undefined} />
              {lists.map((p) => (
                <Card key={p.id} title={p.name} subtitle={`${p.pinned ? '📌 ' : ''}${p.trackIds.length} songs${p.remoteRef ? ' · YouTube' : ''}`}
                  custom={<div className="card-art" style={{ overflow: 'hidden', borderRadius: 14 }}><PlaylistThumb artwork={p.artworkUrl} trackIds={p.trackIds} name={p.name} size="lg" /></div>}
                  onOpen={() => nav(`/playlist/${p.id}`)} onPlay={p.trackIds.length ? () => player().play(trackRegistry.many(p.trackIds), 0, { context: p.name }) : undefined} />
              ))}
            </div>
          ) : (
            <div className="list-card">
              {[{ id: 'liked', name: 'Liked Songs', count: likedCount, updatedAt: 0 }, ...lists.map((p) => ({ id: p.id, name: p.name, count: p.trackIds.length, updatedAt: p.updatedAt, p }))].map((row) => (
                <button key={row.id} className="lib-row" onClick={() => nav(`/playlist/${row.id}`)}>
                  {'p' in row && row.p ? <PlaylistThumb artwork={row.p.artworkUrl} trackIds={row.p.trackIds} name={row.name} /> : <span className="sb-pl-art liked"><Icon name="heartFill" size={14} /></span>}
                  <span className="grow ellipsis" style={{ fontWeight: 560 }}>{row.name}</span>
                  <span className="t-caption">{row.count} songs{row.updatedAt ? ` · ${relative(row.updatedAt)}` : ''}</span>
                </button>
              ))}
            </div>
          )
        )}
        {tab === 'playlists' && lists.length === 0 && !q && (
          <Empty icon="note" title="Make it yours" body="Create a playlist, import from YouTube, or sign in to bring the playlists from your phone." />
        )}

        {tab === 'songs' && (songs.length ? (
          <>
            <div className="row" style={{ marginBottom: 12, gap: 8 }}>
              <button className="btn btn-primary btn-sm" onClick={() => player().play(songs, 0, { context: 'Liked Songs', shuffle: false })}><Icon name="play" size={13} /> Play</button>
              <button className="btn btn-secondary btn-sm" onClick={() => player().play(songs, Math.floor(Math.random() * songs.length), { context: 'Liked Songs', shuffle: true })}><Icon name="shuffle" size={14} /> Shuffle</button>
            </div>
            <TrackList tracks={songs} context="Liked Songs" />
          </>
        ) : <Empty icon="heart" title="No liked songs yet" body="Tap the heart on any song and it lands here — and on your phone." />)}

        {tab === 'artists' && (artists.length ? (
          <div className="grid-cards">
            {artists.map((a) => <Card key={a.key} title={a.name} subtitle={`${a.plays} plays`} art={a.artwork} round icon="user" onOpen={() => nav(`/artist/${encodeURIComponent(a.name)}`)} />)}
          </div>
        ) : <Empty icon="user" title="Your artists appear as you listen" />)}

        {tab === 'history' && (history.length ? (
          <>
            <div className="row" style={{ justifyContent: 'flex-end', marginBottom: 8 }}>
              <button className="btn btn-ghost btn-sm" onClick={() => setConfirmOpen(true)}><Icon name="trash" size={15} /> Clear history</button>
            </div>
            <HistoryList items={history.filter(({ track }) => !q || Math.max(matchScore(q, track.title), matchScore(q, track.artist)) >= 0.55)} />
          </>
        ) : <Empty icon="history" title="Nothing played yet" body="History syncs with the Android app when you’re signed in." />)}

        {tab === 'saved' && (saved.length ? (
          <div className="grid-cards">
            {saved.map((p) => <Card key={p.id} title={p.name} subtitle={p.owner} art={p.artworkUrl} badge={<span className="badge yt">YouTube</span>} onOpen={() => nav(`/playlist/${p.id}`)} />)}
          </div>
        ) : <Empty icon="youtube" title="No saved YouTube playlists" body="Open any YouTube playlist and tap Save to keep it here." />)}

        {tab === 'hidden' && (
          notInterested.length || blocked.length ? (
            <div className="list-card">
              {notInterested.map((id) => { const t = trackRegistry.get(id); return (
                <div key={id} className="lib-row">
                  <Artwork src={t ? artworkFor(t, 'sm') : null} className="imp-art" />
                  <span className="grow ellipsis">{t ? `${t.title} · ${t.artist}` : id}</span>
                  <button className="btn btn-ghost btn-sm" onClick={() => useLibrary.getState().unblock('track', id)}>Allow</button>
                </div>
              ) })}
              {blocked.map((k) => (
                <div key={k} className="lib-row">
                  <span className="avatar ph"><Icon name="user" size={15} /></span>
                  <span className="grow ellipsis">Artist: {k}</span>
                  <button className="btn btn-ghost btn-sm" onClick={() => useLibrary.getState().unblock('artist', k)}>Allow</button>
                </div>
              ))}
            </div>
          ) : <Empty icon="close" title="Nothing hidden" body="“Not interested” and “Don’t recommend this artist” choices show up here, so you can undo them." />
        )}
      </motion.div>
      <YouTubeImport open={importOpen} onClose={() => setImportOpen(false)} />
      <Sheet open={confirmOpen} onClose={() => setConfirmOpen(false)} title="Clear listening history?" width={420}>
        <div className="t-sub">This removes your history from this browser. If you’re signed in, it’s removed from your other devices too. Taste DNA and recommendations start fresh.</div>
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 18 }}>
          <button className="btn btn-ghost" onClick={() => setConfirmOpen(false)}>Cancel</button>
          <button className="btn btn-danger" onClick={() => { useLibrary.getState().clearHistory(); setConfirmOpen(false) }}><Icon name="trash" size={15} /> Clear history</button>
        </div>
      </Sheet>
    </div>
  )
}

function HistoryList({ items }: { items: { track: import('../lib/types').Track; at: number }[] }) {
  const groups = useMemo(() => {
    const out: { label: string; items: typeof items }[] = []
    for (const it of items) {
      const d = new Date(it.at)
      const today = new Date()
      const yest = new Date(); yest.setDate(today.getDate() - 1)
      const label = d.toDateString() === today.toDateString() ? 'Today' : d.toDateString() === yest.toDateString() ? 'Yesterday' : d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })
      const g = out[out.length - 1]
      if (g && g.label === label) g.items.push(it)
      else out.push({ label, items: [it] })
    }
    return out
  }, [items])
  return (
    <div className="col" style={{ gap: 22 }}>
      {groups.map((g) => (
        <div key={g.label}>
          <div className="t-eyebrow" style={{ padding: '0 10px 6px' }}>{g.label}</div>
          <TrackList tracks={g.items.map((i) => i.track)} context="History" number={false} />
        </div>
      ))}
    </div>
  )
}
