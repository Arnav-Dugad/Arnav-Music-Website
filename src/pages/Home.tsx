import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion } from 'motion/react'
import { Card, Shelf, SkeletonCards, Notice, Tilt, spring, Artwork, Spinner } from '../components/ui'
import { Icon } from '../components/Icon'
import { MixArt, MomentArt, QuickPicks } from '../components/Mix'
import { PlaylistThumb } from '../components/Shell'
import { useAsync, useRecentTracks, useRegistryVersion } from '../hooks'
import { trending } from '../lib/youtube'
import { greeting } from '../lib/format'
import { featuredMoment, MOMENTS } from '../lib/moments'
import { SMART, SMART_KINDS, smartPlaylist, timeMachine, singlesOnly } from '../lib/taste'
import { MOODS, MusicError, type Mood } from '../lib/types'
import { artworkFor } from '../lib/classify'
import { allows, likedIds, likedTracks, liveEvents, useLibrary, visiblePlaylists } from '../state/library'
import { useAuth, firstName } from '../state/auth'
import { useSettings } from '../state/settings'
import { player, usePlayer } from '../state/player'
import { trackRegistry } from '../state/tracks'
import { ui } from '../state/ui'
import { useSync } from '../services/sync'
import { dailyMixes, forYouNow, freshFinds, profile, rediscover } from '../services/recs'
import { useYoutubeReady } from '../services/status'
import { verified } from '../services/catalog'
import { useWeather } from '../services/weather'
import { momentById } from '../lib/moments'
import { NowCard, useListeningNow } from '../components/Social'
import { rank } from '../lib/taste'

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

function Hero() {
  const nav = useNavigate()
  const user = useAuth((s) => s.user)
  const moods = useSettings((s) => s.selectedMoods)
  const weather = useWeather((s) => s.weather)
  const weatherOn = useSettings((s) => s.weatherMoods)
  const wLoading = useWeather((s) => s.loading)
  const m = useMemo(() => (weatherOn && weather ? momentById(weather.moment) : null) ?? featuredMoment(new Date().getHours(), moods), [moods, weather, weatherOn])
  const [q, setQ] = useState('')
  const hour = new Date().getHours()
  const name = firstName(user)
  return (
    <section className="home-hero">
      <div className="hero-copy">
        <div className="t-eyebrow">{new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}</div>
        <h1 className="t-hero">{greeting(hour)}{name ? <>, <span className="gradient-text">{name}</span></> : ''}.</h1>
        <form className="ask glass" onSubmit={(e) => { e.preventDefault(); nav(q.trim() ? `/ai?q=${encodeURIComponent(q.trim())}` : '/ai') }}>
          <Icon name="sparkles" size={18} className="ask-icon" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={matchMedia('(max-width: 700px)').matches ? 'Ask Arnav AI for a vibe…' : 'Ask Arnav AI — “45 minutes of upbeat coding music”'} aria-label="Ask Arnav AI" />
          <button type="submit" className="btn btn-primary btn-sm">Create</button>
        </form>
        <div className="hero-chips">
          {weatherOn && weather ? (
            <button className="chip" onClick={() => nav(`/ai?q=${encodeURIComponent(`${weather.label.toLowerCase()} ${new Date().getHours() >= 17 ? 'evening' : 'day'}, ${MOODS[weather.mood].label.toLowerCase()} songs`)}`)}>
              <Icon name={weather.isDay ? 'sun' : 'moon'} size={14} /> {weather.label} · {Math.round(weather.temp)}° — {MOODS[weather.mood].label} songs
            </button>
          ) : (
            <button className="chip" disabled={wLoading} onClick={() => void useWeather.getState().refresh(true)}>{wLoading ? <Spinner size={12} /> : <Icon name="sun" size={14} />} Match the weather</button>
          )}
        </div>
      </div>
      <Tilt className="hero-moment" max={5}>
        <button className="hero-moment-btn" onClick={() => nav(`/moment/${m.id}`)} aria-label={`Open ${m.title} moment`}>
          <MomentArt m={m} large />
          <span className="hero-moment-cta"><Icon name="play" size={14} /> Enter {m.title}</span>
        </button>
      </Tilt>
    </section>
  )
}

function QuickTiles() {
  const nav = useNavigate()
  const playlists = useLibrary((s) => s.playlists)
  const likes = useLibrary((s) => s.likes)
  const tiles = useMemo(() => visiblePlaylists(playlists).slice(0, 7), [playlists])
  const likedCount = useMemo(() => Object.values(likes).filter((l) => !l.deleted).length, [likes])
  if (!tiles.length && !likedCount) return null
  return (
    <div className="quick-tiles">
      <button className="qt" onClick={() => nav('/playlist/liked')}>
        <span className="qt-art liked"><Icon name="heartFill" size={20} /></span>
        <span className="ellipsis">Liked Songs</span>
      </button>
      {tiles.map((p) => (
        <button key={p.id} className="qt" onClick={() => nav(`/playlist/${p.id}`)}>
          <span className="qt-art"><PlaylistThumb artwork={p.artworkUrl} trackIds={p.trackIds} name={p.name} size="lg" /></span>
          <span className="ellipsis">{p.name}</span>
        </button>
      ))}
    </div>
  )
}

export default function Home() {
  const nav = useNavigate()
  const v = useRegistryVersion()
  const rev = useLibrary((s) => s.revision)
  const events = useLibrary((s) => s.events)
  const likes = useLibrary((s) => s.likes)
  const showWhy = useSettings((s) => s.explanations)
  const selectedMoods = useSettings((s) => s.selectedMoods)
  const recent = useRecentTracks(16)
  const yt = useYoutubeReady()
  const chart = useAsync(() => (yt.checked && yt.ready ? trending() : Promise.resolve([])), [yt.ready, yt.checked])
  const nowId = usePlayer((s) => s.queue[s.index]?.track.id)
  const isPlaying = usePlayer((s) => s.isPlaying)
  const signedIn = useAuth((s) => !!s.user)

  const data = useMemo(() => {
    const live = liveEvents(events)
    const liked = likedIds(likes)
    const p = profile()
    const mixes = SMART_KINDS.map((k) => ({ kind: k, tracks: trackRegistry.many(smartPlaylist(k, live, liked)) })).filter((m) => m.tracks.length >= 3)
    const tm = timeMachine(live)[0]
    return {
      cold: p.isCold,
      mixes,
      forYou: forYouNow(16),
      daily: dailyMixes(),
      fresh: freshFinds(12),
      redis: rediscover(12),
      tm: tm ? { ...tm, tracks: trackRegistry.many(tm.trackIds) } : null,
      liked: likedTracks(likes).slice(0, 20),
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v, rev, events, likes])

  const chartRanked = useMemo(() => {
    const list = verified(singlesOnly(chart.data ?? [])).filter((t) => allows(t))
    return data.cold ? list : rank(list, profile(), { discovery: 0.5 }).map((s) => s.track)
  }, [chart.data, data.cold])

  const moodStart = (m: Mood) => nav(`/ai?q=${encodeURIComponent(`${MOODS[m].label.toLowerCase()} songs for right now`)}`)
  const startMoods: Mood[] = [...new Set<Mood>([...selectedMoods, 'UPBEAT', 'CHILL', 'FOCUS', 'ENERGETIC', 'ROMANTIC', 'NOSTALGIC'])].slice(0, 6)

  return (
    <div className="page home">
      <Handoff />
      <Hero />
      <QuickTiles />
      <SetupNotice />
      <FriendsNow />

      {recent.length > 0 && (
        <Shelf title="Continue listening" subtitle="Pick up where you left off">
          {recent.map((t, i) => (
            <Card key={t.id} title={t.title} subtitle={t.artist} art={artworkFor(t)} preview={t} seed={t.artist} playing={nowId === t.id && isPlaying}
              onOpen={() => player().play(recent, i, { context: 'Continue listening' })} onPlay={() => (nowId === t.id ? player().toggle() : player().play(recent, i, { context: 'Continue listening' }))} />
          ))}
        </Shelf>
      )}

      {data.forYou.length >= 4 && (
        <Shelf title="For you right now" subtitle="Picked for this time of day and what you’ve been playing">
          <QuickPicks tracks={data.forYou.map((r) => r.track)} context="For you right now" captions={showWhy ? Object.fromEntries(data.forYou.map((r) => [r.track.id, r.caption])) : undefined} />
        </Shelf>
      )}

      {data.cold && (
        <section className="section">
          <div className="section-head"><div><h2>Start here</h2><div className="t-sub">Tell Arnav AI a mood — it builds a real, playable session</div></div></div>
          <div className="mood-grid">
            {startMoods.map((m, i) => (
              <motion.button key={m} className="mood-tile" style={{ ['--h' as string]: MOODS[m].hue }} onClick={() => moodStart(m)}
                initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ ...spring, delay: i * 0.04 }} whileHover={{ y: -3 }} whileTap={{ scale: 0.97 }}>
                <span>{MOODS[m].label}</span>
                <Icon name="sparkles" size={16} />
              </motion.button>
            ))}
          </div>
        </section>
      )}

      <Shelf title="Moments" subtitle="Immersive environments with music to match" action={<button className="btn btn-ghost btn-sm" onClick={() => nav('/moments')}>See all</button>}>
        {MOMENTS.map((m) => (
          <Card key={m.id} title={m.title} subtitle={m.subtitle} custom={<MomentArt m={m} />} onOpen={() => nav(`/moment/${m.id}`)} />
        ))}
      </Shelf>

      {data.mixes.length > 0 && (
        <Shelf title="Made for you" subtitle="Smart playlists that rebuild themselves as you listen">
          {data.mixes.map((m) => (
            <Card key={m.kind} title={SMART[m.kind].title} subtitle={SMART[m.kind].blurb} custom={<MixArt title={SMART[m.kind].title} hue={SMART[m.kind].hue} tracks={m.tracks} />}
              onOpen={() => nav(`/playlist/smart:${m.kind}`)} onPlay={() => player().play(m.tracks, 0, { context: SMART[m.kind].title })} />
          ))}
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

      {data.tm && data.tm.tracks.length >= 2 && (
        <Shelf title={data.tm.title} subtitle={data.tm.subtitle} action={<button className="btn btn-secondary btn-sm" onClick={() => player().play(data.tm!.tracks, 0, { context: data.tm!.title })}><Icon name="play" size={13} /> Take me back</button>}>
          {data.tm.tracks.map((t, i) => <Card key={t.id} title={t.title} subtitle={t.artist} art={artworkFor(t)} preview={t} onOpen={() => player().play(data.tm!.tracks, i, { context: data.tm!.title })} />)}
        </Shelf>
      )}

      {data.fresh.length >= 4 && (
        <Shelf title="Fresh finds" subtitle="New to you, close to your taste">
          {data.fresh.map((r, i) => <Card key={r.track.id} title={r.track.title} subtitle={showWhy ? r.caption : r.track.artist} art={artworkFor(r.track)} preview={r.track}
            onOpen={() => player().play(data.fresh.map((x) => x.track), i, { context: 'Fresh finds' })} onPlay={() => player().play(data.fresh.map((x) => x.track), i, { context: 'Fresh finds' })} />)}
        </Shelf>
      )}

      {data.redis.length >= 4 && (
        <Shelf title="Rediscover" subtitle="Loved before, quiet lately">
          {data.redis.map((r, i) => <Card key={r.track.id} title={r.track.title} subtitle={showWhy ? r.caption : r.track.artist} art={artworkFor(r.track)} preview={r.track}
            onOpen={() => player().play(data.redis.map((x) => x.track), i, { context: 'Rediscover' })} onPlay={() => player().play(data.redis.map((x) => x.track), i, { context: 'Rediscover' })} />)}
        </Shelf>
      )}

      {yt.ready && (
        <Shelf title="Trending in music" subtitle="From YouTube’s popular music chart" action={<button className="btn btn-ghost btn-sm" onClick={() => nav('/explore')}>Explore</button>}>
          {chart.loading && !chart.data ? <SkeletonCards /> : chart.error ? (
            <div className="t-sub" style={{ padding: '8px 0' }}>{chart.error instanceof MusicError ? chart.error.message : 'Trending couldn’t load.'}</div>
          ) : chartRanked.slice(0, 24).map((t, i) => (
            <Card key={t.id} title={t.title} subtitle={t.artist} art={artworkFor(t)} preview={t} badge={i < 3 ? <span className="badge">#{i + 1}</span> : undefined}
              onOpen={() => player().play(chartRanked, i, { context: 'Trending in music' })} onPlay={() => player().play(chartRanked, i, { context: 'Trending in music' })} />
          ))}
        </Shelf>
      )}

      {data.liked.length > 0 && (
        <Shelf title="From your likes" action={<button className="btn btn-ghost btn-sm" onClick={() => nav('/playlist/liked')}>See all</button>}>
          {data.liked.map((t, i) => <Card key={t.id} title={t.title} subtitle={t.artist} art={artworkFor(t)} preview={t} onOpen={() => player().play(data.liked, i, { context: 'Liked Songs' })} />)}
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
    <Shelf title="Friends listening now" subtitle="Tap Listen along to hear exactly what they hear" action={<button className="btn btn-ghost btn-sm" onClick={() => nav('/friends')}>All friends</button>}>
      {live.slice(0, 8).map((f) => <NowCard key={f.id} f={f} compact />)}
    </Shelf>
  )
}
