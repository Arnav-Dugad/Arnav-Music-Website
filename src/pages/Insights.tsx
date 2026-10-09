import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion } from 'motion/react'
import { Card, Empty, PageHeader, Segmented, Shelf, spring } from '../components/ui'
import { Icon } from '../components/Icon'
import { TrackList } from '../components/TrackRow'
import { Bars, Constellation, Gauge, Heatmap, ListeningClock } from '../components/Charts'
import { useRegistryVersion } from '../hooks'
import { buildProfile, dailyMinutes, discoveryScore, milestones, personality, streaks, topArtists, topTracks } from '../lib/taste'
import { longDuration } from '../lib/format'
import { artworkFor } from '../lib/classify'
import type { Track } from '../lib/types'
import { likedIds, liveEvents, useLibrary } from '../state/library'
import { trackRegistry } from '../state/tracks'
import { player } from '../state/player'
import { coListenedArtists } from '../services/recs'
import { DimHeatmap } from '../components/DimHeatmap'

type Period = 'week' | 'month' | 'year' | 'all'
const DAY = 86_400_000
const SINCE: Record<Period, number> = { week: 7 * DAY, month: 30 * DAY, year: 365 * DAY, all: Infinity }

function exportCsv() {
  const rows = [['started_at', 'title', 'artist', 'album', 'listened_seconds', 'duration_seconds', 'completed', 'skipped', 'track_id']]
  for (const e of liveEvents()) {
    const t = trackRegistry.get(e.trackId)
    rows.push([new Date(e.startedAt).toISOString(), t?.title ?? '', t?.artist ?? e.artistKey, t?.album ?? '', String(Math.round(e.listenedMs / 1000)), e.durationMs ? String(Math.round(e.durationMs / 1000)) : '', String(e.completed), String(e.skipped), e.trackId])
  }
  const csv = rows.map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(',')).join('\n')
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
  a.download = `arnav-music-history-${new Date().toISOString().slice(0, 10)}.csv`
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 2000)
}

export default function Insights() {
  const nav = useNavigate()
  const events = useLibrary((s) => s.events)
  const likes = useLibrary((s) => s.likes)
  const v = useRegistryVersion()
  const [period, setPeriod] = useState<Period>('month')
  const [day, setDay] = useState<number | null>(null)
  const all = useMemo(() => liveEvents(events), [events])
  const now = Date.now()

  const d = useMemo(() => {
    const since = SINCE[period] === Infinity ? 0 : now - SINCE[period]
    const ev = all.filter((e) => e.startedAt >= since)
    const profile = buildProfile(all, (id) => trackRegistry.get(id), likedIds(likes), now)
    const pProfile = buildProfile(ev, (id) => trackRegistry.get(id), new Set(), now)
    const artists = topArtists(ev, (id) => trackRegistry.get(id))
    const tracks = topTracks(ev).map((s) => ({ s, t: trackRegistry.get(s.id) })).filter((x): x is { s: typeof x.s; t: Track } => !!x.t)
    // Recent shifts: artists rising this month compared with the month before.
    const m1 = topArtists(all.filter((e) => e.startedAt >= now - 30 * DAY), (id) => trackRegistry.get(id))
    const m0 = new Map(topArtists(all.filter((e) => e.startedAt >= now - 60 * DAY && e.startedAt < now - 30 * DAY), (id) => trackRegistry.get(id)).map((a) => [a.key, a.ms]))
    const rising = m1.filter((a) => a.ms > 10 * 60_000 && a.ms > (m0.get(a.key) ?? 0) * 2).slice(0, 5)
    const top = topArtists(all, (id) => trackRegistry.get(id)).slice(0, 40)
    const max = Math.max(1, ...top.map((a) => a.ms))
    const nodes = top.map((a) => ({ key: a.key, name: a.name, weight: a.ms / max }))
    const keys = new Set(nodes.map((n) => n.key))
    const links: { a: string; b: string; w: number }[] = []
    for (const n of nodes.slice(0, 25)) for (const c of coListenedArtists(n.key, 4)) if (keys.has(c.key) && n.key < c.key) links.push({ a: n.key, b: c.key, w: c.weight })
    return {
      ev, profile, pProfile, artists, tracks, rising, nodes, links,
      minutes: ev.reduce((a, e) => a + e.listenedMs, 0),
      songs: new Set(ev.map((e) => e.trackId)).size,
      streak: streaks(all, now),
      mile: milestones(all, likedIds(likes).size),
      discovery: discoveryScore(all, now),
      heat: dailyMinutes(all, 371, now),
    }
  }, [all, likes, period, v]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!all.length) {
    return (
      <div className="page">
        <PageHeader title="Taste DNA" subtitle="Your listening, understood — computed on this device." />
        <Empty icon="chart" title="Your Taste DNA starts with a song" body="Play a few songs (or sign in to bring your phone’s history) and your listening clock, gauges, recaps and constellation appear here." action={<button className="btn btn-primary" onClick={() => nav('/explore')}><Icon name="compass" size={15} /> Explore music</button>} />
      </div>
    )
  }
  const persona = personality(d.profile)
  const dayEvents = day != null ? all.filter((e) => e.startedAt >= day && e.startedAt < day + DAY) : []
  const dayTracks = [...new Set(dayEvents.map((e) => e.trackId))].map((id) => trackRegistry.get(id)).filter((t): t is Track => !!t)
  const weekLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

  return (
    <div className="page insights">
      <PageHeader eyebrow="Taste DNA" title={persona.title} subtitle={persona.line} actions={<div className="row" style={{ gap: 8 }}><button className="btn btn-primary btn-sm" onClick={() => nav('/wrapped')}><Icon name="story" size={15} /> Your month, wrapped</button><button className="btn btn-secondary btn-sm" onClick={() => nav('/replay')}><Icon name="chart" size={15} /> Replay</button><button className="btn btn-secondary btn-sm" onClick={() => nav('/wall')}><Icon name="wall" size={15} /> Album wall</button><button className="btn btn-secondary btn-sm" onClick={exportCsv}><Icon name="download" size={15} /> Export CSV</button></div>} />

      <div className="row" style={{ marginTop: 22 }}>
        <Segmented id="period" value={period} onChange={setPeriod} options={[{ value: 'week', label: 'Week' }, { value: 'month', label: 'Month' }, { value: 'year', label: 'Year' }, { value: 'all', label: 'All time' }]} />
      </div>

      <motion.div key={period} className="stats-grid section" style={{ marginTop: 18 }} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={spring}>
        <div className="stat"><span className="v">{Math.round(d.minutes / 60_000).toLocaleString()}</span><span className="k">minutes listened</span></div>
        <div className="stat"><span className="v">{d.songs.toLocaleString()}</span><span className="k">different songs</span></div>
        <div className="stat"><span className="v">{d.artists.length.toLocaleString()}</span><span className="k">artists</span></div>
        <div className="stat"><span className="v"><Icon name="flame" size={22} style={{ verticalAlign: '-3px', color: 'var(--accent)' }} /> {d.streak.current}</span><span className="k">day streak · best {d.streak.longest}</span></div>
      </motion.div>

      {d.artists.length > 0 && (
        <Shelf title="Top artists" subtitle={period === 'all' ? 'All time' : `Last ${period}`}>
          {d.artists.slice(0, 15).map((a, i) => (
            <Card key={a.key} title={`${i + 1}. ${a.name}`} subtitle={`${longDuration(a.ms)} · ${a.plays} plays`} art={a.artwork} round icon="user" onOpen={() => nav(`/artist/${encodeURIComponent(a.name)}`)} />
          ))}
        </Shelf>
      )}

      {d.tracks.length > 0 && (
        <section className="section">
          <div className="section-head"><div><h2>Top songs</h2></div><button className="btn btn-secondary btn-sm" onClick={() => player().play(d.tracks.slice(0, 50).map((x) => x.t), 0, { context: `Your top songs · ${period}` })}><Icon name="play" size={13} /> Play all</button></div>
          <TrackList tracks={d.tracks.slice(0, 10).map((x) => x.t)} context={`Your top songs · ${period}`} captions={Object.fromEntries(d.tracks.slice(0, 10).map((x) => [x.t.id, `${x.s.plays} plays`]))} />
        </section>
      )}

      <section className="section dna-grid">
        <div className="card-surface dna-card">
          <div className="t-headline">Listening clock</div>
          <div className="t-caption">When you listen, by hour</div>
          <div className="center" style={{ marginTop: 10 }}><ListeningClock hours={d.pProfile.hourHistogram} /></div>
        </div>
        <div className="card-surface dna-card">
          <div className="t-headline">Week rhythm</div>
          <div className="t-caption">Minutes by weekday</div>
          <Bars values={d.pProfile.dayHistogram} labels={weekLabels} height={200} />
        </div>
        <div className="card-surface dna-card gauges">
          <Gauge value={d.profile.discoveryRatio} label="Discovery" sub="Songs heard only once" />
          <Gauge value={d.profile.repeatTendency} label="Repeat" sub="Songs on heavy rotation" />
          <Gauge value={d.profile.skipRate} label="Skips" sub="Skipped early" />
          {d.discovery != null && <Gauge value={d.discovery} label="This week" sub="Listening that was new" />}
        </div>
      </section>

      <section className="section">
        <div className="section-head"><div><h2>By film, era and composer</h2><div className="t-sub">The last 12 months — what you played, grouped</div></div></div>
        <DimHeatmap events={liveEvents(events)} />
      </section>

      <section className="section">
        <div className="section-head"><div><h2>Listening calendar</h2><div className="t-sub">The last year — tap a day</div></div></div>
        <div className="card-surface" style={{ padding: 18 }}>
          <Heatmap days={d.heat} onPick={(x) => setDay(x.day)} />
          {day != null && (
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} style={{ marginTop: 16 }}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <div className="t-headline">{new Date(day).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })} · {Math.round(dayEvents.reduce((a, e) => a + e.listenedMs, 0) / 60_000)} min</div>
                {dayTracks.length > 0 && <button className="btn btn-secondary btn-sm" onClick={() => player().play(dayTracks, 0, { context: 'Take me back to this day' })}><Icon name="play" size={13} /> Take me back</button>}
              </div>
              {dayTracks.length ? <TrackList tracks={dayTracks.slice(0, 12)} context="That day" number={false} /> : <div className="t-sub" style={{ marginTop: 8 }}>No listening that day.</div>}
            </motion.div>
          )}
        </div>
      </section>

      {d.rising.length > 0 && (
        <section className="section">
          <div className="section-head"><div><h2>Recent shifts</h2><div className="t-sub">Artists you’re playing more than last month</div></div></div>
          <div className="row" style={{ flexWrap: 'wrap', gap: 10 }}>
            {d.rising.map((a) => <button key={a.key} className="chip" onClick={() => nav(`/artist/${encodeURIComponent(a.name)}`)}><Icon name="bolt" size={14} /> {a.name}</button>)}
          </div>
        </section>
      )}

      {d.nodes.length >= 3 && (
        <section className="section">
          <div className="section-head"><div><h2>Taste constellation</h2><div className="t-sub">Your artists as stars; threads where you play them together. Drag to pan, scroll to zoom.</div></div></div>
          <div className="card-surface constellation-wrap"><Constellation nodes={d.nodes} links={d.links} onPick={(n) => nav(`/artist/${encodeURIComponent(n)}`)} /></div>
        </section>
      )}

      <section className="section">
        <div className="section-head"><div><h2>Milestones</h2><div className="t-sub">No reminders, no nags — just markers</div></div></div>
        <div className="mile-grid">
          {d.mile.map((m) => (
            <div key={m.id} className={`mile card-surface ${m.reached ? 'done' : ''}`}>
              <Icon name={m.reached ? 'trophy' : 'clock'} size={20} />
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="t-headline">{m.title}</div>
                <div className="mile-bar"><motion.i initial={{ scaleX: 0 }} whileInView={{ scaleX: m.progress }} viewport={{ once: true }} transition={{ duration: 1, ease: [0.32, 0.72, 0, 1] }} /></div>
                <div className="t-caption">{m.detail}</div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {d.tracks[0] && (
        <section className="section">
          <div className="recap glass">
            <img src={artworkFor(d.tracks[0].t)} alt="" className="recap-bg" />
            <div className="recap-content">
              <div className="t-eyebrow" style={{ color: 'rgba(255,255,255,.7)' }}>Your {period === 'all' ? 'all-time' : period} in music</div>
              <div className="t-large" style={{ color: '#fff' }}>{Math.round(d.minutes / 60_000).toLocaleString()} minutes</div>
              <div style={{ color: 'rgba(255,255,255,.85)' }}>Top song: <b>{d.tracks[0].t.title}</b>{d.artists[0] ? <> · Top artist: <b>{d.artists[0].name}</b></> : null}</div>
            </div>
          </div>
        </section>
      )}
    </div>
  )
}
