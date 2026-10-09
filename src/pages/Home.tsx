/**
 * Home, laid out like YouTube Music: mood chips, a paged Speed dial, Forgotten favourites, a
 * Blend invite, Quick picks and Trending as paged song lists, Keep listening, Albums for you —
 * all ranked by the on-device recommender (src/lib/recommender.ts).
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion } from 'motion/react'
import { Card, Eq, Shelf, SkeletonCards, Notice, spring, Artwork } from '../components/ui'
import { Icon, Logo } from '../components/Icon'
import { MixArt, MomentArt } from '../components/Mix'
import { PlaylistThumb } from '../components/Shell'
import { albumHref, openTrackMenu } from '../components/TrackRow'
import { useMoreMenu } from '../components/MobileMenu'
import { useAsync, useIsDesktop, useRecentTracks, useRegistryVersion } from '../hooks'
import { trending } from '../lib/youtube'
import { compactCount, duration } from '../lib/format'
import { MOMENTS } from '../lib/moments'
import { SMART, SMART_KINDS, smartPlaylist, timeMachine } from '../lib/taste'
import { MOODS, type Mood, type Track } from '../lib/types'
import { artworkFor } from '../lib/classify'
import { likedIds, likedTracks, liveEvents, useLibrary, visiblePlaylists } from '../state/library'
import { useAuth, firstName } from '../state/auth'
import { useSettings } from '../state/settings'
import { player, usePlayer } from '../state/player'
import { trackRegistry } from '../state/tracks'
import { ui } from '../state/ui'
import { useSync } from '../services/sync'
import { albumsForYou, dailyMixes, forYouNow, freshFinds, model, rediscover, topArtists, trendingForYou, warmSeeds, type Rec } from '../services/recs'
import { useYoutubeReady } from '../services/status'
import { NowCard, useListeningNow } from '../components/Social'
import { useSocial } from '../services/social'

// ── Top of the page ─────────────────────────────────────────────────────────
function TopBar() {
  const nav = useNavigate()
  const user = useAuth((s) => s.user)
  const pending = useSocial((s) => s.incoming.length + s.unread)
  const initial = (user?.displayName || user?.email || '').trim()[0]?.toUpperCase()
  return (
    <header className="h-top">
      <span className="h-brand"><Logo size={26} /><span className="t-brand">Arnav Music</span></span>
      <span className="grow" />
      <button className="icon-btn h-bell" aria-label={pending ? `Friends · ${pending} new` : 'Friends and inbox'} onClick={() => nav(pending ? '/friends?tab=inbox' : '/friends')}>
        <Icon name="bell" size={21} />{pending > 0 && <i className="h-dot" />}
      </button>
      <button className="icon-btn" aria-label="Search" onClick={() => nav('/explore')}><Icon name="search" size={21} /></button>
      <button className="h-avatar" aria-label="Settings and more" onClick={() => useMoreMenu.getState().set(true)}>
        {user?.photoURL ? <img src={user.photoURL} alt="" referrerPolicy="no-referrer" /> : initial ? <span>{initial}</span> : <Icon name="user" size={17} />}
      </button>
    </header>
  )
}

const CHIPS: { label: string; q: string; mood?: Mood }[] = [
  { label: 'Feel good', q: 'feel good happy songs', mood: 'UPBEAT' },
  { label: 'Romance', q: 'romantic love songs', mood: 'ROMANTIC' },
  { label: 'Relax', q: 'relaxing chill songs', mood: 'CHILL' },
  { label: 'Energize', q: 'high energy upbeat songs', mood: 'ENERGETIC' },
  { label: 'Party', q: 'party dance songs' },
  { label: 'Workout', q: 'workout gym motivation songs' },
  { label: 'Focus', q: 'focus deep work music', mood: 'FOCUS' },
  { label: 'Sad', q: 'sad heartbreak songs' },
  { label: 'Commute', q: 'songs for the drive' },
  { label: 'Sleep', q: 'calm sleep music' },
]

function MoodChips() {
  const nav = useNavigate()
  return (
    <div className="h-chips" role="list">
      {CHIPS.map((c, i) => (
        <motion.button key={c.label} role="listitem" className="chip h-chip" onClick={() => nav(`/ai?q=${encodeURIComponent(c.q)}`)}
          initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ ...spring, delay: i * 0.025 }} whileTap={{ scale: 0.94 }}>
          {c.label}
        </motion.button>
      ))}
    </div>
  )
}

// ── Speed dial: your most-used playlists, artists, mixes and songs, 9 to a page ──
interface DialItem { key: string; label: string; art: ReactNode; open: () => void; collection: boolean }

function useSpeedDial(): DialItem[] {
  const nav = useNavigate()
  const v = useRegistryVersion()
  const playlists = useLibrary((s) => s.playlists)
  const likes = useLibrary((s) => s.likes)
  const rev = useLibrary((s) => s.revision)
  const recent = useRecentTracks(18)
  return useMemo(() => {
    const items: DialItem[] = []
    const liked = likedTracks(likes)
    if (liked.length) items.push({ key: 'liked', label: 'Liked Songs', collection: true, open: () => nav('/playlist/liked'), art: <span className="dial-liked"><Icon name="heartFill" size={30} /></span> })
    const pls = visiblePlaylists(playlists).filter((p) => p.trackIds.length).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 4)
    for (const p of pls) items.push({ key: p.id, label: p.name, collection: true, open: () => nav(`/playlist/${p.id}`), art: <PlaylistThumb artwork={p.artworkUrl} trackIds={p.trackIds} name={p.name} size="lg" /> })
    const live = liveEvents()
    const replay = trackRegistry.many(smartPlaylist('MOST_REPLAYED', live, likedIds(likes)))
    if (replay.length >= 4) items.push({ key: 'replay', label: 'Replay Mix', collection: true, open: () => nav('/playlist/smart:MOST_REPLAYED'), art: <MixArt title="Replay Mix" hue={8} tracks={replay} eyebrow="Mix" /> })
    for (const a of topArtists(6)) items.push({ key: `a:${a.key}`, label: a.name, collection: true, open: () => nav(`/artist/${encodeURIComponent(a.name)}`), art: <Artwork src={artworkFor(a.track)} seed={a.name} /> })
    const daily = dailyMixes()[0]
    if (daily) items.push({ key: daily.id, label: daily.title, collection: true, open: () => nav(`/playlist/daily:${daily.id.replace('daily_', '')}`), art: <MixArt title={daily.title} hue={daily.hue} tracks={daily.tracks} eyebrow="Daily" /> })
    const used = new Set(items.map((i) => i.label.toLowerCase()))
    for (const [i, t] of recent.entries()) {
      if (items.length >= 27) break
      if (used.has(t.title.toLowerCase())) continue
      items.push({ key: t.id, label: t.title, collection: false, open: () => player().play(recent, i, { context: 'Speed dial' }), art: <Artwork src={artworkFor(t)} seed={t.artist} /> })
    }
    return items.slice(0, 27)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v, playlists, likes, rev, recent])
}

function SpeedDial() {
  const nav = useNavigate()
  const items = useSpeedDial()
  const user = useAuth((s) => s.user)
  const ref = useRef<HTMLDivElement>(null)
  const [page, setPage] = useState(0)
  if (items.length < 3) return null
  const pages: DialItem[][] = []
  for (let i = 0; i < items.length; i += 9) pages.push(items.slice(i, i + 9))
  const name = user?.displayName || firstName(user) || 'Your'
  return (
    <section className="section h-dial">
      <button className="h-dial-head" onClick={() => nav('/library')}>
        <span className="h-dial-avatar">{user?.photoURL ? <img src={user.photoURL} alt="" referrerPolicy="no-referrer" /> : <Icon name="user" size={16} />}</span>
        <span className="col" style={{ gap: 0, minWidth: 0, textAlign: 'left' }}>
          <span className="t-eyebrow ellipsis">{user ? name : 'For you'}</span>
          <span className="h-title">Speed dial</span>
        </span>
        <span className="grow" />
        <Icon name="chevronRight" size={20} className="subtle" />
      </button>
      <div className="h-dial-pages" ref={ref} onScroll={(e) => { const el = e.currentTarget; setPage(Math.round(el.scrollLeft / Math.max(1, el.clientWidth * 0.94))) }}>
        {pages.map((pg, pi) => (
          <div key={pi} className="h-dial-page">
            {pg.map((it, i) => (
              <motion.button key={it.key} className="dial-tile" onClick={it.open} aria-label={it.label}
                initial={{ opacity: 0, scale: 0.92 }} animate={{ opacity: 1, scale: 1 }} transition={{ ...spring, delay: Math.min(i, 8) * 0.03 }} whileTap={{ scale: 0.95 }}>
                <span className="dial-art">{it.art}</span>
                <span className="dial-label"><span className="ellipsis">{it.label}</span>{it.collection && <Icon name="chevronRight" size={13} />}</span>
              </motion.button>
            ))}
          </div>
        ))}
      </div>
      {pages.length > 1 && (
        <div className="h-dots" aria-hidden>{pages.map((_, i) => <i key={i} className={i === page ? 'on' : ''} />)}</div>
      )}
    </section>
  )
}

// ── Paged song lists (Quick picks, Trending): 4 rows a column, swipe for more ──
function SongPages({ title, recs, context, more }: { title: string; recs: Rec[]; context: string; more?: ReactNode }) {
  const tracks = recs.map((r) => r.track)
  const nowId = usePlayer((s) => s.queue[s.index]?.track.id)
  const playing = usePlayer((s) => s.isPlaying)
  const cols: Rec[][] = []
  for (let i = 0; i < recs.length; i += 4) cols.push(recs.slice(i, i + 4))
  return (
    <section className="section h-songs">
      <div className="section-head">
        <h2>{title}</h2>
        <div className="row" style={{ gap: 8 }}>{more}<button className="btn btn-secondary btn-sm h-playall" onClick={() => player().play(tracks, 0, { context })}>Play all</button></div>
      </div>
      <div className="h-song-cols">
        {cols.map((col, ci) => (
          <div key={ci} className="h-song-col">
            {col.map((r, i) => {
              const idx = ci * 4 + i
              const on = nowId === r.track.id
              return (
                <motion.div key={r.track.id} className={`h-song ${on ? 'on' : ''}`} role="button" tabIndex={0}
                  onClick={() => (on ? player().toggle() : player().play(tracks, idx, { context }))}
                  onKeyDown={(e) => { if (e.key === 'Enter') player().play(tracks, idx, { context }) }}
                  initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} transition={{ ...spring, delay: Math.min(idx, 8) * 0.025 }}>
                  <span className="h-song-art">
                    <Artwork src={artworkFor(r.track, 'sm')} seed={r.track.artist} />
                    {on && <span className="h-song-eq"><Eq playing={playing} /></span>}
                  </span>
                  <span className="h-song-text">
                    <span className="ellipsis h-song-title">{r.track.title}</span>
                    <span className="ellipsis t-caption">{r.track.artist}{r.track.views ? ` · ${compactCount(r.track.views)} plays` : ''}{r.caption && !/^More from/.test(r.caption) ? ` · ${r.caption}` : ''}</span>
                  </span>
                  <button className="icon-btn sm" aria-label="More" onClick={(e) => { e.stopPropagation(); openTrackMenu(e, r.track) }}><Icon name="more" size={18} /></button>
                </motion.div>
              )
            })}
          </div>
        ))}
      </div>
    </section>
  )
}

function BlendInvite() {
  const nav = useNavigate()
  const friends = useSocial((s) => s.friends)
  const f = friends.find((x) => x.taste?.tracks?.length)
  return (
    <section className="section">
      <motion.button className="h-blend" onClick={() => nav(f ? `/u/${f.handle}` : '/friends')} whileTap={{ scale: 0.98 }}>
        <span className="col" style={{ gap: 4, textAlign: 'left', flex: 1, minWidth: 0 }}>
          <b>{f ? `Your Blend with ${f.name.split(' ')[0]}` : 'Match your taste with friends and get a playlist'}</b>
          <span className="t-caption">{f ? 'Songs you both love, taking turns' : 'Add a friend — Arnav mixes your favourites together'}</span>
          <span className="h-blend-go"><Icon name="chevronRight" size={18} /></span>
        </span>
        <span className="h-blend-art" aria-hidden><i /><i /><span><Icon name="plus" size={22} /></span></span>
      </motion.button>
    </section>
  )
}

function SetupNotice() {
  const yt = useYoutubeReady()
  const nav = useNavigate()
  if (yt.ready) return null
  return (
    <div className="section">
      <Notice tone="warn" icon="youtube" action={<button className="btn btn-sm btn-secondary" onClick={() => nav('/settings/sources')}>Connect</button>}>
        {yt.reason === 'noApi' ? 'The music API isn’t reachable on this host, so search and charts are paused. Your library and lyrics still work.' : 'Search and charts need a YouTube Data API key. Add one in Settings → Sources (it stays in this browser), or set it on the server.'}
      </Notice>
    </div>
  )
}

function Handoff() {
  const rq = useSync((s) => s.remoteQueue)
  const hasQueue = usePlayer((s) => s.queue.length > 0)
  const [dismissed, setDismissed] = useState(false)
  if (!rq || rq.fromThisDevice || dismissed) return null
  const t = rq.tracks[rq.index]
  if (!t) return null
  if (hasQueue && usePlayer.getState().queue[usePlayer.getState().index]?.track.id === t.id) return null
  return (
    <motion.div className="handoff glass" initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} transition={spring}>
      <Artwork src={artworkFor(t, 'sm')} className="handoff-art" />
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="t-eyebrow">Continue from your phone</div>
        <div className="ellipsis" style={{ fontWeight: 640 }}>{t.title} <span className="muted">· {t.artist}</span></div>
        <div className="t-caption">{rq.tracks.length} songs in your phone’s queue</div>
      </div>
      <button className="btn btn-primary btn-sm" onClick={() => { player().play(rq.tracks, rq.index, { context: 'From your phone', shuffle: false }); setDismissed(true) }}><Icon name="play" size={14} /> Resume</button>
      <button className="icon-btn sm" aria-label="Dismiss" onClick={() => setDismissed(true)}><Icon name="close" size={16} /></button>
    </motion.div>
  )
}

export default function Home() {
  const nav = useNavigate()
  const desktop = useIsDesktop()
  const v = useRegistryVersion()
  const rev = useLibrary((s) => s.revision)
  const events = useLibrary((s) => s.events)
  const likes = useLibrary((s) => s.likes)
  const seeds = useSettings((s) => s.seedArtists)
  const selectedMoods = useSettings((s) => s.selectedMoods)
  const recent = useRecentTracks(12)
  const yt = useYoutubeReady()
  const chart = useAsync(() => (yt.checked && yt.ready ? trending() : Promise.resolve([])), [yt.ready, yt.checked])
  const signedIn = useAuth((s) => !!s.user)

  const data = useMemo(() => {
    const live = liveEvents(events)
    const liked = likedIds(likes)
    const m = model()
    const archive = trackRegistry.many(smartPlaylist('FORGOTTEN_FAVORITES', live, liked))
    const mixes = SMART_KINDS.filter((k) => k !== 'FORGOTTEN_FAVORITES' && k !== 'MOST_REPLAYED').map((k) => ({ kind: k, tracks: trackRegistry.many(smartPlaylist(k, live, liked)) })).filter((x) => x.tracks.length >= 3)
    const tm = timeMachine(live)[0]
    return {
      cold: m.cold,
      quick: forYouNow(20),
      redis: rediscover(10),
      archive,
      mixes,
      daily: dailyMixes(),
      fresh: freshFinds(12),
      albums: albumsForYou(12),
      tm: tm ? { ...tm, tracks: trackRegistry.many(tm.trackIds) } : null,
      liked: likedTracks(likes).slice(0, 20),
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v, rev, events, likes, seeds])

  const trend = useMemo(() => trendingForYou(chart.data ?? [], 20), [chart.data, data.cold])
  // New listener: bring in songs by the artists they picked (Home re-ranks when they arrive).
  useEffect(() => { if (data.cold && seeds.length) void warmSeeds() }, [data.cold, seeds])
  // Keep listening: what you played lately, videos first (they get the wide cards).
  const keep = useMemo(() => [...recent].sort((a, b) => Number(b.variant === 'VIDEO') - Number(a.variant === 'VIDEO')).slice(0, 10), [recent])
  const startMoods: Mood[] = [...new Set<Mood>([...selectedMoods, 'UPBEAT', 'CHILL', 'FOCUS', 'ENERGETIC', 'ROMANTIC', 'NOSTALGIC'])].slice(0, 6)

  return (
    <div className="page home h-home">
      {!desktop && <TopBar />}
      <MoodChips />
      <Handoff />
      <SetupNotice />
      <SpeedDial />
      <FriendsNow />

      {(data.archive.length >= 3 || data.redis.length >= 2) && (
        <Shelf title="Forgotten favourites">
          {data.archive.length >= 3 && <Card title="Archive mix" subtitle="Mix · loved once, quiet lately" custom={<MixArt title="Archive Mix" hue={150} tracks={data.archive} eyebrow="Mix" />} onOpen={() => nav('/playlist/smart:FORGOTTEN_FAVORITES')} onPlay={() => player().play(data.archive, 0, { context: 'Archive mix' })} />}
          {data.redis.map((r, i) => <Card key={r.track.id} title={r.track.title} subtitle={`${r.track.artist} · ${r.caption}`} art={artworkFor(r.track)} preview={r.track}
            onOpen={() => player().play(data.redis.map((x) => x.track), i, { context: 'Forgotten favourites' })} onPlay={() => player().play(data.redis.map((x) => x.track), i, { context: 'Forgotten favourites' })} />)}
        </Shelf>
      )}

      <BlendInvite />

      {data.quick.length >= 4 && <SongPages title="Quick picks" recs={data.quick} context="Quick picks" />}

      {data.cold && (
        <section className="section">
          <div className="section-head"><div><h2>Start here</h2><div className="t-sub">Pick a mood — Arnav AI builds a real, playable session</div></div></div>
          <div className="mood-grid">
            {startMoods.map((m, i) => (
              <motion.button key={m} className="mood-tile" style={{ ['--h' as string]: MOODS[m].hue }} onClick={() => nav(`/ai?q=${encodeURIComponent(`${MOODS[m].label.toLowerCase()} songs for right now`)}`)}
                initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ ...spring, delay: i * 0.04 }} whileTap={{ scale: 0.97 }}>
                <span>{MOODS[m].label}</span>
                <Icon name="sparkles" size={16} />
              </motion.button>
            ))}
          </div>
        </section>
      )}

      {keep.length >= 2 && (
        <Shelf title="Keep listening">
          {keep.map((t, i) => <Card key={t.id} wide title={t.title} subtitle={t.artist} art={artworkFor(t)} preview={t} badge={t.durationMs ? <span className="badge">{duration(t.durationMs)}</span> : undefined}
            onOpen={() => player().play(keep, i, { context: 'Keep listening' })} onPlay={() => player().play(keep, i, { context: 'Keep listening' })} />)}
        </Shelf>
      )}

      {yt.ready && (chart.loading && !chart.data ? <Shelf title="Trending songs for you"><SkeletonCards /></Shelf> : trend.length >= 4 && <SongPages title="Trending songs for you" recs={trend} context="Trending songs for you" />)}

      {data.albums.length >= 2 && (
        <Shelf title="Albums for you">
          {data.albums.map((a) => <Card key={a.name} title={a.name} subtitle={`Album · ${a.artist}`} art={a.art} seed={a.name}
            onOpen={() => nav(albumHref({ album: a.name, artist: a.artist }))} onPlay={() => player().play(a.tracks, 0, { context: a.name })} />)}
        </Shelf>
      )}

      {data.daily.length > 0 && (
        <Shelf title="Your daily mixes" subtitle="A familiar core with a few close new songs">
          {data.daily.map((d) => (
            <Card key={d.id} title={d.title} subtitle={d.artists.join(', ')} custom={<MixArt title={d.title} eyebrow="Daily" hue={d.hue} tracks={d.tracks} />}
              onOpen={() => nav(`/playlist/daily:${d.id.replace('daily_', '')}`)} onPlay={() => player().play(d.tracks, 0, { context: d.title })} />
          ))}
        </Shelf>
      )}

      {data.fresh.length >= 4 && (
        <Shelf title="Fresh finds" subtitle="New to you, close to your taste">
          {data.fresh.map((r, i) => <Card key={r.track.id} title={r.track.title} subtitle={r.caption} art={artworkFor(r.track)} preview={r.track}
            onOpen={() => player().play(data.fresh.map((x) => x.track), i, { context: 'Fresh finds' })} onPlay={() => player().play(data.fresh.map((x) => x.track), i, { context: 'Fresh finds' })} />)}
        </Shelf>
      )}

      {data.mixes.length > 0 && (
        <Shelf title="Made for you" subtitle="Smart playlists that rebuild themselves as you listen">
          {data.mixes.map((x) => (
            <Card key={x.kind} title={SMART[x.kind].title} subtitle={SMART[x.kind].blurb} custom={<MixArt title={SMART[x.kind].title} hue={SMART[x.kind].hue} tracks={x.tracks} />}
              onOpen={() => nav(`/playlist/smart:${x.kind}`)} onPlay={() => player().play(x.tracks, 0, { context: SMART[x.kind].title })} />
          ))}
        </Shelf>
      )}

      {data.tm && data.tm.tracks.length >= 2 && (
        <Shelf title={data.tm.title} subtitle={data.tm.subtitle} action={<button className="btn btn-secondary btn-sm" onClick={() => player().play(data.tm!.tracks, 0, { context: data.tm!.title })}><Icon name="play" size={13} /> Take me back</button>}>
          {data.tm.tracks.map((t, i) => <Card key={t.id} title={t.title} subtitle={t.artist} art={artworkFor(t)} preview={t} onOpen={() => player().play(data.tm!.tracks, i, { context: data.tm!.title })} />)}
        </Shelf>
      )}

      <Shelf title="Moments" subtitle="Immersive scenes with music to match" action={<button className="btn btn-ghost btn-sm" onClick={() => nav('/moments')}>See all</button>}>
        {MOMENTS.map((mo) => <Card key={mo.id} title={mo.title} subtitle={mo.subtitle} custom={<MomentArt m={mo} />} onOpen={() => nav(`/moment/${mo.id}`)} />)}
      </Shelf>

      {data.liked.length > 0 && (
        <Shelf title="From your likes" action={<button className="btn btn-ghost btn-sm" onClick={() => nav('/playlist/liked')}>See all</button>}>
          {data.liked.map((t: Track, i) => <Card key={t.id} title={t.title} subtitle={t.artist} art={artworkFor(t)} preview={t} onOpen={() => player().play(data.liked, i, { context: 'Liked Songs' })} />)}
        </Shelf>
      )}

      {!signedIn && (
        <section className="section">
          <div className="signin-card glass">
            <div className="grow">
              <div className="t-title">Bring your phone’s library</div>
              <div className="t-sub">Sign in with the same account as the Android app — likes, playlists and history sync both ways.</div>
            </div>
            <button className="btn btn-primary" onClick={() => ui().set({ authOpen: true })}>Sign in</button>
          </div>
        </section>
      )}
    </div>
  )
}

/** Friends playing music right now — one tap to listen along. */
function FriendsNow() {
  const nav = useNavigate()
  const live = useListeningNow()
  if (!live.length) return null
  return (
    <Shelf title="Friends listening now" action={<button className="btn btn-ghost btn-sm" onClick={() => nav('/friends')}>All friends</button>}>
      {live.slice(0, 8).map((f) => <NowCard key={f.id} f={f} compact />)}
    </Shelf>
  )
}
