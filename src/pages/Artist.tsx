import { useMemo } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { motion } from 'motion/react'
import { Artwork, Card, Notice, Shelf, SkeletonRows, Spinner } from '../components/ui'
import { Icon } from '../components/Icon'
import { TrackList } from '../components/TrackRow'
import { startRadio } from '../components/Overlays'
import { useAsync, usePaletteFor, useRegistryVersion } from '../hooks'
import { cachedSearch, channelInfo, search } from '../lib/youtube'
import { artworkFor, isSingle, rankForListening } from '../lib/classify'
import { compactCount, longDuration, relative } from '../lib/format'
import { hourLabel } from '../lib/taste'
import { artistKey, MusicError, type Track } from '../lib/types'
import { liveEvents, useLibrary } from '../state/library'
import { trackRegistry } from '../state/tracks'
import { player } from '../state/player'
import { coListenedArtists } from '../services/recs'

export default function ArtistPage() {
  const { name: raw = '' } = useParams()
  const [params] = useSearchParams()
  const nav = useNavigate()
  const name = decodeURIComponent(raw)
  const key = artistKey(name)
  const channelParam = params.get('c') || null
  const v = useRegistryVersion()
  const events = useLibrary((s) => s.events)

  const channel = useAsync(async () => {
    let id = channelParam
    if (!id) {
      const c = await cachedSearch(name, 'ARTISTS')
      id = c?.artists.find((a) => a.key === key)?.channelId ?? null
      if (!id) id = trackRegistry.all().find((t) => artistKey(t.artist) === key && t.channelId)?.channelId ?? null
    }
    return id ? channelInfo(id).catch(() => null) : null
  }, [channelParam, name])

  const top = useAsync(async () => (await search(`${name}`, 'SONGS')).tracks, [name])

  const mine = useMemo(() => {
    const ev = liveEvents(events).filter((e) => e.artistKey === key)
    if (!ev.length) return null
    const ms = ev.reduce((a, e) => a + e.listenedMs, 0)
    const byTrack = new Map<string, number>()
    ev.forEach((e) => byTrack.set(e.trackId, (byTrack.get(e.trackId) ?? 0) + 1))
    const tops = [...byTrack.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => trackRegistry.get(id)).filter((t): t is Track => !!t).slice(0, 10)
    const months: { label: string; minutes: number }[] = []
    const now = new Date()
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
      const end = new Date(now.getFullYear(), now.getMonth() - i + 1, 1)
      months.push({ label: d.toLocaleDateString([], { month: 'short' }), minutes: ev.filter((e) => e.startedAt >= d.getTime() && e.startedAt < end.getTime()).reduce((a, e) => a + e.listenedMs, 0) / 60000 })
    }
    const hours = Array(24).fill(0)
    ev.forEach((e) => { hours[new Date(e.startedAt).getHours()] += e.listenedMs })
    const peak = hours.indexOf(Math.max(...hours))
    return { plays: ev.length, ms, first: Math.min(...ev.map((e) => e.startedAt)), last: Math.max(...ev.map((e) => e.startedAt)), tops, months, peak }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, key, v])

  const topTracks = useMemo(() => {
    const list = (top.data ?? []).filter(isSingle)
    const own = list.filter((t) => artistKey(t.artist) === key || (channel.data && t.channelId === channel.data.id))
    return rankForListening(own.length >= 5 ? own : list, 'SONG').slice(0, 20)
  }, [top.data, key, channel.data])

  const similar = useMemo(() => coListenedArtists(key, 8), [key, events]) // eslint-disable-line react-hooks/exhaustive-deps
  const avatar = channel.data?.avatar ?? mine?.tops[0]?.artworkUrl ?? topTracks[0]?.artworkUrl ?? null
  const palette = usePaletteFor(avatar)
  const displayName = channel.data?.name || name
  const playable = topTracks.length ? topTracks : mine?.tops ?? []
  const maxMonth = Math.max(1, ...(mine?.months.map((m) => m.minutes) ?? [1]))

  return (
    <div className="page artist-page">
      <div className="artist-hero" style={{ ['--t1' as string]: palette.bg[0], ['--t2' as string]: palette.vivid }}>
        {channel.data?.banner && <img className="artist-banner" src={channel.data.banner} alt="" />}
        <div className="artist-hero-shade" />
        <div className="artist-hero-content">
          <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: 'spring', stiffness: 200, damping: 22 }}>
            <Artwork src={avatar} round className="artist-avatar" seed={name} icon="user" eager />
          </motion.div>
          <div style={{ minWidth: 0 }}>
            <div className="t-eyebrow">Artist</div>
            <h1 className="t-hero ellipsis">{displayName}</h1>
            <div className="t-sub">{channel.data?.subscribers ? `${compactCount(channel.data.subscribers)} subscribers` : ''}{mine ? `${channel.data?.subscribers ? ' · ' : ''}You’ve played ${mine.plays} times` : ''}</div>
            <div className="row" style={{ marginTop: 16, gap: 10, flexWrap: 'wrap' }}>
              <button className="btn btn-primary btn-lg" disabled={!playable.length} onClick={() => player().play(playable, 0, { context: displayName, shuffle: false })}><Icon name="play" size={16} /> Play</button>
              <button className="btn btn-secondary btn-lg" disabled={!playable.length} onClick={() => player().play(playable, 0, { context: displayName, shuffle: true })}><Icon name="shuffle" size={16} /> Shuffle</button>
              <button className="btn btn-secondary btn-lg" disabled={!playable.length} onClick={() => playable[0] && void startRadio(playable[0])}><Icon name="radio" size={16} /> Radio</button>
              {channel.data && <a className="icon-btn" href={`https://www.youtube.com/channel/${channel.data.id}`} target="_blank" rel="noreferrer" aria-label="Open on YouTube"><Icon name="youtube" size={20} /></a>}
            </div>
          </div>
        </div>
      </div>

      <section className="section">
        <div className="section-head"><div><h2>Top songs</h2><div className="t-sub">Official uploads first</div></div></div>
        {top.loading && !top.data ? <SkeletonRows n={8} /> : top.error && !topTracks.length ? (
          <Notice tone="warn">{top.error instanceof MusicError ? top.error.message : 'Songs couldn’t load.'}</Notice>
        ) : topTracks.length ? <TrackList tracks={topTracks} context={displayName} /> : <div className="t-sub">No songs found.</div>}
      </section>

      {mine && (
        <section className="section">
          <div className="section-head"><div><h2>You and {displayName}</h2><div className="t-sub">Computed on this device from your listening</div></div></div>
          <div className="stats-grid">
            <div className="stat"><span className="v">{mine.plays}</span><span className="k">plays</span></div>
            <div className="stat"><span className="v">{longDuration(mine.ms)}</span><span className="k">listening time</span></div>
            <div className="stat"><span className="v">{relative(mine.first)}</span><span className="k">first listen</span></div>
            <div className="stat"><span className="v">{hourLabel(mine.peak)}</span><span className="k">when you play them most</span></div>
          </div>
          <div className="month-chart card-surface">
            {mine.months.map((m, i) => (
              <div key={i} className="mc-col" title={`${Math.round(m.minutes)} min`}>
                <motion.div className="mc-bar" initial={{ scaleY: 0 }} animate={{ scaleY: Math.max(0.02, m.minutes / maxMonth) }} transition={{ type: 'spring', stiffness: 140, damping: 20, delay: i * 0.03 }} />
                <span className="t-caption">{m.label}</span>
              </div>
            ))}
          </div>
          {mine.tops.length > 0 && (
            <div style={{ marginTop: 22 }}>
              <div className="t-eyebrow" style={{ padding: '0 10px 8px' }}>Your top songs · last played {relative(mine.last)}</div>
              <TrackList tracks={mine.tops} context={`Your ${displayName}`} />
            </div>
          )}
        </section>
      )}

      {similar.length > 0 && (
        <Shelf title="You also play" subtitle="Artists that share your listening sessions">
          {similar.map((a) => {
            const t = trackRegistry.all().find((x) => artistKey(x.artist) === a.key)
            return <Card key={a.key} title={a.name} subtitle={`${a.weight} shared sessions`} art={t ? artworkFor(t, 'sm') : null} round icon="user" onOpen={() => nav(`/artist/${encodeURIComponent(a.name)}`)} />
          })}
        </Shelf>
      )}

      {channel.data?.description && (
        <section className="section">
          <div className="section-head"><h2>About</h2></div>
          <p className="t-sub about-text">{channel.data.description}</p>
        </section>
      )}
      {channel.loading && <div className="t-caption" style={{ marginTop: 20 }}><Spinner size={12} /> Loading artist…</div>}
    </div>
  )
}
