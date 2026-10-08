import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { AnimatePresence, motion } from 'motion/react'
import { Card, Shelf, SkeletonRows, Notice, Segmented, Spinner, Artwork, spring } from '../components/ui'
import { Icon } from '../components/Icon'
import { TrackList } from '../components/TrackRow'
import { MomentArt } from '../components/Mix'
import { useAsync, useDebounced, useRegistryVersion } from '../hooks'
import { cachedSearch, search, trending, video, type SearchFilter, type SearchResults } from '../lib/youtube'
import { artworkFor, rankForListening } from '../lib/classify'
import { DEBOUNCE_MS, isRemoteWorthy, matchScore } from '../lib/query'
import { relative } from '../lib/format'
import { MOMENTS } from '../lib/moments'
import { MOODS, MOOD_KEYS, MusicError, type Track } from '../lib/types'
import { likedTracks, useLibrary, visiblePlaylists } from '../state/library'
import { trackRegistry } from '../state/tracks'
import { player, usePlayer } from '../state/player'
import { regionCode } from '../state/settings'
import { useYoutubeReady } from '../services/status'

const GENRES: { name: string; q: string; hue: number }[] = [
  { name: 'Pop', q: 'pop songs', hue: 330 }, { name: 'Hip-Hop', q: 'hip hop songs', hue: 28 }, { name: 'Bollywood', q: 'bollywood songs', hue: 12 },
  { name: 'Punjabi', q: 'punjabi songs', hue: 48 }, { name: 'Lo-fi', q: 'lofi songs', hue: 200 }, { name: 'EDM', q: 'edm songs', hue: 280 },
  { name: 'Rock', q: 'rock songs', hue: 0 }, { name: 'R&B', q: 'r&b songs', hue: 300 }, { name: 'Indie', q: 'indie songs', hue: 150 },
  { name: 'K-Pop', q: 'k-pop songs', hue: 316 }, { name: 'Latin', q: 'latin songs', hue: 20 }, { name: 'Jazz', q: 'jazz songs', hue: 210 },
  { name: 'Classical', q: 'classical music pieces', hue: 40 }, { name: 'Tamil', q: 'tamil songs', hue: 170 }, { name: 'Telugu', q: 'telugu songs', hue: 100 },
  { name: 'Soundtracks', q: 'movie soundtrack songs', hue: 240 }, { name: 'Country', q: 'country songs', hue: 34 }, { name: 'Metal', q: 'metal songs', hue: 350 },
]
const REGIONS = ['US', 'IN', 'GB', 'CA', 'AU', 'DE', 'FR', 'JP', 'KR', 'BR', 'MX', 'ES']

const FILTERS: { value: SearchFilter; label: string }[] = [
  { value: 'ALL', label: 'All' }, { value: 'SONGS', label: 'Songs' }, { value: 'VIDEOS', label: 'Videos' }, { value: 'ARTISTS', label: 'Artists' }, { value: 'PLAYLISTS', label: 'Playlists' },
]

const YT_LINK = /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/)|youtu\.be\/|music\.youtube\.com\/watch\?(?:.*&)?v=)([A-Za-z0-9_-]{11})/
const YT_PLAYLIST = /[?&]list=([A-Za-z0-9_-]{12,64})/

function Browse() {
  const nav = useNavigate()
  const [, setParams] = useSearchParams()
  const [region, setRegion] = useState(regionCode())
  const yt = useYoutubeReady()
  const chart = useAsync(() => (yt.checked && yt.ready ? trending(region) : Promise.resolve([] as Track[])), [region, yt.ready, yt.checked])
  const recents = useLibrary((s) => s.recentSearches)
  const run = (q: string, f: SearchFilter = 'SONGS') => setParams({ q, f })
  return (
    <>
      {recents.length > 0 && (
        <section className="section">
          <div className="section-head"><h2>Recent searches</h2><button className="btn btn-ghost btn-sm" onClick={() => useLibrary.getState().clearRecentSearches()}>Clear</button></div>
          <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
            {recents.map((r) => <button key={r} className="chip" onClick={() => setParams({ q: r })}><Icon name="history" size={14} /> {r}</button>)}
          </div>
        </section>
      )}
      <section className="section">
        <div className="section-head"><div><h2>Browse genres</h2><div className="t-sub">Singles only — no hour-long mixes</div></div></div>
        <div className="genre-grid">
          {GENRES.map((g, i) => (
            <motion.button key={g.name} className="genre-tile" style={{ ['--h' as string]: g.hue }} onClick={() => run(g.q)}
              initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ ...spring, delay: Math.min(i, 12) * 0.02 }} whileHover={{ y: -3 }} whileTap={{ scale: 0.97 }}>
              <span>{g.name}</span>
            </motion.button>
          ))}
        </div>
      </section>
      <section className="section">
        <div className="section-head"><div><h2>Moods</h2><div className="t-sub">Or let Arnav AI shape a whole session</div></div></div>
        <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
          {MOOD_KEYS.map((m) => (
            <button key={m} className="chip mood-chip" style={{ ['--h' as string]: MOODS[m].hue }} onClick={() => nav(`/ai?q=${encodeURIComponent(`${MOODS[m].label.toLowerCase()} songs`)}`)}>
              {MOODS[m].label}
            </button>
          ))}
        </div>
      </section>
      <Shelf title="Moments" action={<button className="btn btn-ghost btn-sm" onClick={() => nav('/moments')}>See all</button>}>
        {MOMENTS.map((m) => <Card key={m.id} title={m.title} subtitle={m.subtitle} custom={<MomentArt m={m} />} onOpen={() => nav(`/moment/${m.id}`)} />)}
      </Shelf>
      {yt.ready && (
        <section className="section">
          <div className="section-head">
            <div><h2>Top music videos</h2><div className="t-sub">YouTube’s popular music chart</div></div>
            <select className="chip-select" value={region} onChange={(e) => setRegion(e.target.value)} aria-label="Chart region">
              {[...new Set([regionCode(), ...REGIONS])].map((r) => <option key={r} value={r}>{new Intl.DisplayNames(['en'], { type: 'region' }).of(r) ?? r}</option>)}
            </select>
          </div>
          {chart.loading && !chart.data ? <SkeletonRows n={10} /> : chart.error ? <div className="t-sub">{chart.error instanceof MusicError ? chart.error.message : 'The chart couldn’t load.'}</div> : (
            <div className="chart-grid">
              {(chart.data ?? []).slice(0, 30).map((t, i, all) => (
                <button key={t.id} className="chart-row" onClick={() => player().play(all, i, { context: 'Top music videos' })}>
                  <span className="chart-rank tabular">{i + 1}</span>
                  <Artwork src={artworkFor(t, 'sm')} letterbox={false} className="chart-art" />
                  <span className="grow" style={{ minWidth: 0 }}>
                    <span className="ellipsis" style={{ display: 'block', fontWeight: 600 }}>{t.title}</span>
                    <span className="ellipsis t-sub" style={{ display: 'block', fontSize: 13 }}>{t.artist}</span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>
      )}
    </>
  )
}

function LocalMatches({ q }: { q: string }) {
  const v = useRegistryVersion()
  const playlists = useLibrary((s) => s.playlists)
  const nav = useNavigate()
  const { tracks, lists } = useMemo(() => {
    const seen = new Set<string>()
    const pool = [...likedTracks(), ...trackRegistry.all().reverse()].filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true)))
    const tracks = pool.map((t) => ({ t, s: Math.max(matchScore(q, t.title), matchScore(q, `${t.title} ${t.artist}`), matchScore(q, t.artist) * 0.85) }))
      .filter((x) => x.s >= 0.6).sort((a, b) => b.s - a.s).slice(0, 5).map((x) => x.t)
    const lists = visiblePlaylists(playlists).filter((p) => matchScore(q, p.name) >= 0.6).slice(0, 4)
    return { tracks, lists }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, v, playlists])
  if (!tracks.length && !lists.length) return null
  return (
    <section className="section" style={{ marginTop: 24 }}>
      <div className="section-head"><div><h2 style={{ fontSize: 17 }}>In your library</h2></div></div>
      {lists.length > 0 && (
        <div className="row" style={{ flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
          {lists.map((p) => <button key={p.id} className="chip" onClick={() => nav(`/playlist/${p.id}`)}><Icon name="note" size={14} /> {p.name}</button>)}
        </div>
      )}
      <TrackList tracks={tracks} context={`“${q}” in your library`} number={false} />
    </section>
  )
}

function Results({ q, filter }: { q: string; filter: SearchFilter }) {
  const nav = useNavigate()
  const prefer = usePlayer((s) => s.mode)
  const [res, setRes] = useState<SearchResults | null>(null)
  const [more, setMore] = useState<Track[]>([])
  const [token, setToken] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<MusicError | null>(null)
  const debounced = useDebounced(q, DEBOUNCE_MS)
  const reqId = useRef(0)

  // Instant: cached results for the exact query, as you type.
  useEffect(() => {
    let alive = true
    void cachedSearch(q, filter).then((c) => { if (alive && c) { setRes(c); setToken(c.nextPageToken ?? null) } })
    return () => { alive = false }
  }, [q, filter])

  useEffect(() => {
    if (!isRemoteWorthy(debounced)) return
    const id = ++reqId.current
    setLoading(true)
    setError(null)
    setMore([])
    search(debounced, filter)
      .then((r) => {
        if (id !== reqId.current) return
        setRes(r)
        setToken(r.nextPageToken ?? null)
        useLibrary.getState().addRecentSearch(debounced)
      })
      .catch((e) => { if (id === reqId.current) setError(e instanceof MusicError ? e : new MusicError('http', 'Search failed.')) })
      .finally(() => { if (id === reqId.current) setLoading(false) })
  }, [debounced, filter])

  const loadMore = async () => {
    if (!token) return
    setLoadingMore(true)
    try {
      const r = await search(debounced, filter, token)
      setMore((m) => [...m, ...r.tracks])
      setToken(r.nextPageToken ?? null)
    } catch (e) {
      setError(e instanceof MusicError ? e : null)
    } finally {
      setLoadingMore(false)
    }
  }

  const tracks = useMemo(() => {
    const all = [...(res?.tracks ?? []), ...more]
    const ranked = filter === 'VIDEOS' ? rankForListening(all, 'VIDEO') : rankForListening(all, prefer)
    return filter === 'VIDEOS' ? ranked.filter((t) => t.variant !== 'SONG') : ranked
  }, [res, more, filter, prefer])

  if (error && !res) {
    return <div className="section"><Notice tone={error.kind === 'quota' ? 'warn' : 'error'} icon={error.kind === 'missingKey' ? 'youtube' : 'info'} action={error.kind === 'missingKey' ? <button className="btn btn-sm btn-secondary" onClick={() => nav('/settings/sources')}>Connect</button> : undefined}>{error.message}</Notice></div>
  }
  if (!res) return <div className="section"><SkeletonRows n={8} /></div>
  const top = res.artists[0] && matchScore(q, res.artists[0].name) >= 0.75 ? { kind: 'artist' as const, a: res.artists[0] } : tracks[0] ? { kind: 'track' as const, t: tracks[0] } : null

  return (
    <motion.div key={`${res.query}|${filter}`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.25 }}>
      <div className="row t-caption" style={{ marginTop: 18, minHeight: 20 }}>
        {loading ? <><Spinner size={12} /> Searching YouTube…</> : res.fromCache ? <>Saved results · {relative(res.fetchedAt)}</> : null}
        {error && res && <span style={{ color: 'var(--warning)' }}>{error.message}</span>}
      </div>
      {filter === 'ALL' && top && (
        <section className="section top-section">
          <div className="top-grid">
            <div>
              <div className="section-head"><h2>Top result</h2></div>
              {top.kind === 'artist' ? (
                <button className="top-card glass-thin" onClick={() => nav(`/artist/${encodeURIComponent(top.a.name)}?c=${top.a.channelId ?? ''}`)}>
                  <Artwork src={top.a.artworkUrl} round className="top-art" seed={top.a.name} icon="user" />
                  <div className="t-large ellipsis" style={{ fontSize: 30 }}>{top.a.name}</div>
                  <span className="badge">Artist</span>
                </button>
              ) : (
                <button className="top-card glass-thin" onClick={() => player().play(tracks, 0, { context: `Search “${q}”` })}>
                  <Artwork src={artworkFor(top.t)} className="top-art" seed={top.t.artist} />
                  <div className="t-large ellipsis" style={{ fontSize: 28 }}>{top.t.title}</div>
                  <div className="row"><span className="badge">{top.t.variant === 'VIDEO' ? 'Video' : 'Song'}</span><span className="muted">{top.t.artist}</span></div>
                  <span className="top-play"><Icon name="play" size={20} /></span>
                </button>
              )}
            </div>
            <div style={{ minWidth: 0 }}>
              <div className="section-head"><h2>Songs</h2></div>
              <TrackList tracks={tracks.slice(0, 5)} context={`Search “${q}”`} number={false} showAlbum={false} />
            </div>
          </div>
        </section>
      )}
      {filter !== 'ARTISTS' && filter !== 'PLAYLISTS' && tracks.length > (filter === 'ALL' ? 5 : 0) && (
        <section className="section">
          {filter === 'ALL' && <div className="section-head"><h2>More songs</h2></div>}
          <TrackList tracks={filter === 'ALL' ? tracks.slice(5) : tracks} context={`Search “${q}”`} number={false} />
          {token && filter !== 'ALL' && (
            <div className="center" style={{ marginTop: 18 }}>
              <button className="btn btn-secondary" onClick={() => void loadMore()} disabled={loadingMore}>{loadingMore ? <Spinner size={14} /> : null} Load more</button>
            </div>
          )}
        </section>
      )}
      {res.artists.length > 0 && filter !== 'SONGS' && filter !== 'VIDEOS' && filter !== 'PLAYLISTS' && (
        <Shelf title="Artists">
          {res.artists.map((a) => <Card key={a.key} title={a.name} subtitle="Artist" art={a.artworkUrl} round icon="user" onOpen={() => nav(`/artist/${encodeURIComponent(a.name)}?c=${a.channelId ?? ''}`)} />)}
        </Shelf>
      )}
      {res.playlists.length > 0 && filter !== 'SONGS' && filter !== 'VIDEOS' && filter !== 'ARTISTS' && (
        <Shelf title="Playlists">
          {res.playlists.map((p) => <Card key={p.id} title={p.name} subtitle={p.owner} art={p.artworkUrl} onOpen={() => nav(`/playlist/${p.id}`)} />)}
        </Shelf>
      )}
      {!loading && !tracks.length && !res.artists.length && !res.playlists.length && <div className="empty"><div className="t-title">No results for “{q}”</div><div className="t-sub">Try a different spelling, or an artist name.</div></div>}
    </motion.div>
  )
}

export default function Explore() {
  const [params, setParams] = useSearchParams()
  const nav = useNavigate()
  const q = params.get('q') ?? ''
  const filter = (params.get('f') as SearchFilter) || 'ALL'
  const [text, setText] = useState(q)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => { setText(q) }, [q])
  useEffect(() => { if (params.get('focus')) input.current?.focus() }, [params])

  const onChange = (v: string) => {
    setText(v)
    const link = YT_LINK.exec(v)
    if (link) {
      void video(link[1]).then((t) => { player().play([t], 0, { context: 'Shared link' }); setText(''); setParams({}) }).catch(() => undefined)
      return
    }
    const pl = YT_PLAYLIST.exec(v)
    if (pl && /youtu/.test(v)) { nav(`/playlist/ytpl:${pl[1]}`); return }
    const next = new URLSearchParams(params)
    if (v.trim()) next.set('q', v)
    else next.delete('q')
    next.delete('focus')
    setParams(next, { replace: true })
  }

  return (
    <div className="page explore">
      <div className="search-head">
        <h1 className="t-large">{q ? 'Search' : 'Explore'}</h1>
        <div className="search-box glass">
          <Icon name="search" size={19} />
          <input ref={input} value={text} onChange={(e) => onChange(e.target.value)} placeholder="Songs, artists, playlists — or paste a YouTube link" aria-label="Search" autoComplete="off" spellCheck={false} />
          <AnimatePresence>{text && <motion.button initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} className="icon-btn sm" aria-label="Clear" onClick={() => onChange('')}><Icon name="close" size={16} /></motion.button>}</AnimatePresence>
        </div>
        {q && (
          <div style={{ marginTop: 14, overflowX: 'auto' }}>
            <Segmented id="search-filter" value={filter} onChange={(f) => { const n = new URLSearchParams(params); n.set('f', f); setParams(n, { replace: true }) }} options={FILTERS} />
          </div>
        )}
      </div>
      {q ? (
        <>
          <LocalMatches q={q} />
          <Results q={q} filter={filter} />
        </>
      ) : <Browse />}
    </div>
  )
}
