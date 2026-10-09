/**
 * Replay, like Apple Music Replay: your month (or year) at a glance — minutes, where you listened
 * and your streaks, then your top artists on glass cards, top songs and top albums. Periods come
 * from your history, or from the saved, synced snapshot when this device no longer has it all.
 */
import { useEffect, useMemo } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { motion } from 'motion/react'
import { Artwork, Empty, spring } from '../components/ui'
import { Icon } from '../components/Icon'
import { albumHref } from '../components/TrackRow'
import { liveEvents, useLibrary } from '../state/library'
import { trackRegistry } from '../state/tracks'
import { player } from '../state/player'
import { usePrefs, type FormFactor, type ReplaySnapshot } from '../state/prefs'
import { toast } from '../state/ui'
import { deviceId } from '../services/sync'
import { snapshotReplays } from '../services/replay'
import { artworkFor } from '../lib/classify'
import { buildWrapped, monthKey, rangeOf, wrappedMonths, wrappedYears } from '../lib/wrapped'
import { deviceMinutes, download, formFactor, pickReplay, replayCsv, replayJson, streaks, toSnapshot } from '../lib/replay'
import type { Track } from '../lib/types'

const fmt = (n: number) => n.toLocaleString()
const DEVICE: Record<FormFactor, { label: string; icon: 'headphones' | 'grid' | 'tv' }> = {
  phone: { label: 'Phone', icon: 'headphones' },
  tablet: { label: 'Tablet', icon: 'grid' },
  desktop: { label: 'Computer', icon: 'tv' },
}
/** A saved song, as a playable track (the full copy when this device has it). */
const playable = (s: ReplaySnapshot['songs'][number]): Track => trackRegistry.get(s.track.id) ?? ({ ...s.track, genres: [] } as Track)

export default function ReplayPage() {
  const { period } = useParams()
  const nav = useNavigate()
  const events = useLibrary((s) => s.events)
  const saved = usePrefs((s) => s.replay)
  const devices = usePrefs((s) => s.devices)
  const live = useMemo(() => liveEvents(events), [events])
  const periods = useMemo(() => {
    const ks = new Set([...wrappedYears(live), ...wrappedMonths(live), ...Object.keys(saved)])
    // Years first, then months, newest first.
    return [...ks].sort((a, b) => (a.length !== b.length ? a.length - b.length : b.localeCompare(a)))
  }, [live, saved])
  const months = periods.filter((k) => k.length === 7)
  const key = period && /^\d{4}(-\d{2})?$/.test(period) ? period : months[0] ?? monthKey(Date.now())
  const best = useMemo(() => streaks(live), [live])
  const { view, fromSaved } = useMemo(() => {
    const w = buildWrapped(key, live, (id) => trackRegistry.get(id), 10)
    const { start, end } = rangeOf(key)
    const computed = w ? toSnapshot(w, deviceMinutes(live, start, end, devices, deviceId, formFactor()), best.longest) : null
    return pickReplay(computed, saved[key])
  }, [key, live, saved, devices, best.longest])
  // Save what this device can see (the synced copy keeps it if older history is trimmed later).
  useEffect(() => { const t = setTimeout(() => { try { snapshotReplays() } catch { /* best effort */ } }, 1200); return () => clearTimeout(t) }, [live.length])

  const record = Math.max(best.longest, ...Object.values(saved).map((s) => s.bestStreak ?? 0))
  const pick = (k: string) => nav(`/replay/${k}`, { replace: true })
  const thisYear = String(new Date().getFullYear())
  const short = (k: string) => (k.length === 4 ? (k === thisYear ? `${k} so far` : k) : new Date(Number(k.slice(0, 4)), Number(k.slice(5)) - 1, 1).toLocaleDateString(undefined, { month: 'short', year: k.slice(0, 4) === thisYear ? undefined : '2-digit' }))
  const allViews = (): ReplaySnapshot[] => periods.map((k) => (k === key && view ? view : (() => {
    const w = buildWrapped(k, live, (id) => trackRegistry.get(id), 10)
    const { start, end } = rangeOf(k)
    return pickReplay(w ? toSnapshot(w, deviceMinutes(live, start, end, devices, deviceId, formFactor()), best.longest) : null, saved[k]).view
  })())).filter((v): v is ReplaySnapshot => !!v)
  const exportCsv = () => { if (view) { download(`arnav-replay-${view.key}.csv`, replayCsv([view]), 'text/csv'); toast(`Exported ${view.label} as CSV`) } }
  const exportJson = () => { const all = allViews(); download(`arnav-replay-all-${new Date().toISOString().slice(0, 10)}.json`, replayJson(all), 'application/json'); toast(`Exported ${all.length} Replay${all.length === 1 ? '' : 's'} as JSON`) }

  const devTotal = view ? Object.values(view.devices ?? {}).reduce((a, b) => a + b, 0) : 0
  const devRows = view ? (Object.entries(view.devices ?? {}) as [FormFactor, number][]).filter(([, m]) => m > 0).sort((a, b) => b[1] - a[1]) : []

  return (
    <div className="page rp">
      <header className="rp-head">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <span className="t-eyebrow">Replay</span>
            <h1 className="t-large">{view ? view.label : 'Your Replay'}</h1>
          </div>
          {view && (
            <div className="row rp-export" style={{ gap: 6 }}>
              <button className="btn btn-secondary btn-sm" onClick={exportCsv} title="This period: artists, songs and albums with minutes and plays"><Icon name="download" size={14} /> CSV</button>
              <button className="btn btn-secondary btn-sm" onClick={exportJson} title="Every period, as JSON"><Icon name="download" size={14} /> All as JSON</button>
            </div>
          )}
        </div>
        {periods.length > 1 && (
          <div className="rp-periods" role="tablist" aria-label="Period">
            {periods.map((k) => (
              <button key={k} role="tab" aria-selected={k === key} className={`chip ${k === key ? 'on' : ''}`} onClick={() => pick(k)}>{short(k)}</button>
            ))}
          </div>
        )}
      </header>

      {!view ? (
        <Empty icon="story" title="Nothing to replay yet" body="Listen for a while — your top artists, songs and albums land here as soon as you've played 30 minutes in a month." />
      ) : (
        <>
          {fromSaved && (
            <div className="rp-saved t-caption"><Icon name="cloud" size={14} /> Saved Replay — this device no longer has all of this period’s history, so you’re seeing the copy kept with your account.</div>
          )}
          <motion.section className="rp-hero glass-card" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={spring}>
            <div className="rp-hero-art" aria-hidden>{view.songs[0] && <Artwork src={artworkFor(playable(view.songs[0]))} seed={view.songs[0].track.artist} hi />}</div>
            <div className="rp-hero-body">
              <span className="t-caption">You listened for</span>
              <b className="rp-mins">{fmt(view.minutes)} <small>minutes</small></b>
              <span className="t-caption">
                {fmt(view.plays)} plays · {fmt(view.artistsCount)} artists
                {view.change != null && <> · <span className={view.change >= 0 ? 'rp-up' : 'rp-down'}>{view.change >= 0 ? '+' : ''}{Math.round(view.change)}%</span> vs {view.kind === 'year' ? 'last year' : 'last month'}</>}
              </span>
              <div className="row" style={{ gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
                <button className="btn btn-primary btn-sm" onClick={() => nav(`/wrapped/${key}`)} disabled={fromSaved} title={fromSaved ? 'The story needs this period’s full history' : undefined}><Icon name="story" size={15} /> Watch the story</button>
                <button className="btn btn-secondary btn-sm" onClick={() => player().play(view.songs.map(playable), 0, { context: `Replay · ${view.label}` })}><Icon name="play" size={15} /> Play top songs</button>
              </div>
            </div>
          </motion.section>

          <div className="rp-stats">
            <section className="rp-stat glass-card" aria-label="Streaks">
              <span className="t-eyebrow"><Icon name="flame" size={13} /> Streaks</span>
              <div className="rp-streaks">
                <div><b>{view.streak}</b><span className="t-caption">days in a row {view.kind === 'year' ? 'this year' : 'this month'}</span></div>
                <div><b>{best.current}</b><span className="t-caption">current streak</span></div>
                <div className={record > 0 && view.streak >= record ? 'rp-record' : ''}>
                  <b><Icon name="trophy" size={18} /> {record}</b>
                  <span className="t-caption">{record > 0 && view.streak >= record ? 'your record — set this period' : 'your record'}</span>
                </div>
              </div>
            </section>
            {devTotal > 0 && (
              <section className="rp-stat glass-card" aria-label="Where you listened">
                <span className="t-eyebrow"><Icon name="headphones" size={13} /> Where you listened</span>
                <ul className="rp-devices">
                  {devRows.map(([k, m]) => (
                    <li key={k}>
                      <span className="rp-dev-name"><Icon name={DEVICE[k].icon} size={15} /> {DEVICE[k].label}</span>
                      <span className="rp-dev-bar" aria-hidden><i style={{ width: `${Math.max(3, (m / devTotal) * 100)}%` }} /></span>
                      <span className="rp-dev-val">{fmt(m)} min · {Math.round((m / devTotal) * 100)}%</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>

          <section className="section">
            <div className="section-head"><h2>Your Top Artists</h2></div>
            <div className="rp-artists">
              {view.artists.map((a, i) => (
                <motion.button key={a.name} className={`rp-artist glass-card ${i === 0 ? 'first' : ''}`} onClick={() => nav(`/artist/${encodeURIComponent(a.name)}`)}
                  initial={{ opacity: 0, y: 18, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ ...spring, delay: 0.04 * i }}>
                  <span className="rp-artist-bg" aria-hidden>{a.art && <img src={a.art} alt="" loading="lazy" />}</span>
                  <span className="rp-rank">{i + 1}</span>
                  <Artwork src={a.art} seed={a.name} round className="rp-artist-art" />
                  <span className="rp-artist-text">
                    <b className="ellipsis">{a.name}</b>
                    <span className="t-caption">{fmt(a.minutes)} min · {fmt(a.plays)} plays</span>
                  </span>
                </motion.button>
              ))}
            </div>
          </section>

          <section className="section">
            <div className="section-head"><h2>Top Songs</h2></div>
            <ol className="rp-songs">
              {view.songs.map((s, i) => (
                <li key={s.track.id}>
                  <button className="rp-song" onClick={() => player().play(view.songs.map(playable), i, { context: `Replay · ${view.label}` })}>
                    <Artwork src={artworkFor(playable(s))} seed={s.track.artist} className="rp-song-art" />
                    <span className="rp-num">{i + 1}</span>
                    <span className="col grow" style={{ minWidth: 0, gap: 2 }}>
                      <b className="ellipsis">{s.track.title}</b>
                      <span className="t-caption ellipsis">{s.track.artist}</span>
                    </span>
                    <span className="t-caption rp-plays">{fmt(s.plays)} {s.plays === 1 ? 'play' : 'plays'}</span>
                  </button>
                </li>
              ))}
            </ol>
          </section>

          {view.albums.length > 0 && (
            <section className="section">
              <div className="section-head"><h2>Top Albums</h2></div>
              <div className="rp-albums">
                {view.albums.map((a, i) => (
                  <button key={a.name} className="rp-album" onClick={() => nav(albumHref({ album: a.name, artist: a.artist }))}>
                    <span className="rp-album-art"><Artwork src={a.art} seed={a.name} /><span className="rp-rank sm">{i + 1}</span></span>
                    <b className="ellipsis">{a.name}</b>
                    <span className="t-caption ellipsis">{a.artist} · {fmt(a.minutes)} min</span>
                  </button>
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  )
}
