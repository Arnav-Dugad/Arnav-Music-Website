/**
 * Replay, like Apple Music Replay: your month (or year) at a glance — minutes, then your top
 * artists on glass cards, top songs and top albums. "Watch the story" opens the Wrapped slides.
 */
import { useMemo } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { motion } from 'motion/react'
import { Artwork, Empty, spring } from '../components/ui'
import { Icon } from '../components/Icon'
import { albumHref } from '../components/TrackRow'
import { liveEvents, useLibrary } from '../state/library'
import { trackRegistry } from '../state/tracks'
import { player } from '../state/player'
import { artworkFor } from '../lib/classify'
import { buildWrapped, monthKey, wrappedMonths, wrappedYears } from '../lib/wrapped'

const fmt = (n: number) => n.toLocaleString()

export default function ReplayPage() {
  const { period } = useParams()
  const nav = useNavigate()
  const events = useLibrary((s) => s.events)
  const live = useMemo(() => liveEvents(events), [events])
  const months = useMemo(() => wrappedMonths(live), [live])
  const years = useMemo(() => wrappedYears(live), [live])
  const key = period && /^\d{4}(-\d{2})?$/.test(period) ? period : months[0] ?? monthKey(Date.now())
  const w = useMemo(() => buildWrapped(key, live, (id) => trackRegistry.get(id), 10), [key, live])
  const periods = [...years, ...months]
  const pick = (k: string) => nav(`/replay/${k}`, { replace: true })
  const short = (k: string) => (/^\d{4}$/.test(k) ? `${k} so far` : new Date(Number(k.slice(0, 4)), Number(k.slice(5)) - 1, 1).toLocaleDateString(undefined, { month: 'short', year: k.slice(0, 4) === String(new Date().getFullYear()) ? undefined : '2-digit' }))

  return (
    <div className="page rp">
      <header className="rp-head">
        <span className="t-eyebrow">Replay</span>
        <h1 className="t-large">{w ? w.label : 'Your Replay'}</h1>
        {periods.length > 1 && (
          <div className="rp-periods" role="tablist" aria-label="Period">
            {periods.map((k) => (
              <button key={k} role="tab" aria-selected={k === key} className={`chip ${k === key ? 'on' : ''}`} onClick={() => pick(k)}>{short(k)}</button>
            ))}
          </div>
        )}
      </header>

      {!w ? (
        <Empty icon="story" title="Nothing to replay yet" body="Listen for a while — your top artists, songs and albums land here as soon as you've played 30 minutes in a month." />
      ) : (
        <>
          <motion.section className="rp-hero glass-card" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={spring}>
            <div className="rp-hero-art" aria-hidden>{w.songs[0] && <Artwork src={artworkFor(w.songs[0].track)} seed={w.songs[0].track.artist} hi />}</div>
            <div className="rp-hero-body">
              <span className="t-caption">You listened for</span>
              <b className="rp-mins">{fmt(w.minutes)} <small>minutes</small></b>
              <span className="t-caption">
                {fmt(w.plays)} plays · {fmt(w.artistsCount)} artists
                {w.change != null && <> · <span className={w.change >= 0 ? 'rp-up' : 'rp-down'}>{w.change >= 0 ? '+' : ''}{Math.round(w.change)}%</span> vs {w.kind === 'year' ? 'last year' : 'last month'}</>}
              </span>
              <div className="row" style={{ gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
                <button className="btn btn-primary btn-sm" onClick={() => nav(`/wrapped/${key}`)}><Icon name="story" size={15} /> Watch the story</button>
                <button className="btn btn-secondary btn-sm" onClick={() => player().play(w.songs.map((s) => s.track), 0, { context: `Replay · ${w.label}` })}><Icon name="play" size={15} /> Play top songs</button>
              </div>
            </div>
          </motion.section>

          <section className="section">
            <div className="section-head"><h2>Your Top Artists</h2></div>
            <div className="rp-artists">
              {w.artists.map((a, i) => (
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
              {w.songs.map((s, i) => (
                <li key={s.track.id}>
                  <button className="rp-song" onClick={() => player().play(w.songs.map((x) => x.track), i, { context: `Replay · ${w.label}` })}>
                    <Artwork src={artworkFor(s.track)} seed={s.track.artist} className="rp-song-art" />
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

          {w.albums.length > 0 && (
            <section className="section">
              <div className="section-head"><h2>Top Albums</h2></div>
              <div className="rp-albums">
                {w.albums.map((a, i) => (
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
