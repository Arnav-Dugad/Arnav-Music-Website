import { useMemo } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { motion } from 'motion/react'
import { Artwork, Notice, SkeletonRows } from '../components/ui'
import { Icon } from '../components/Icon'
import { ArtistLinks } from '../components/TrackRow'
import { useAsync, usePaletteFor, usePageTheme } from '../hooks'
import { artworkFor } from '../lib/classify'
import { fetchCredits, type CreditsResult } from '../lib/meta'
import { groupCredits, type CreditEntry } from '../lib/credits'
import { trackRegistry } from '../state/tracks'
import { player } from '../state/player'
import type { Track } from '../lib/types'

const LINKABLE = new Set(['PERFORMED', 'WRITTEN', 'PRODUCED', 'ENGINEERING'])

function sourceLine(r: CreditsResult): string {
  const s = r.sources
  if (!s.length) return 'No credits were published for this upload.'
  const list = s.length === 1 ? s[0] : `${s.slice(0, -1).join(', ')} and ${s[s.length - 1]}`
  return `From ${list.replace('Title', 'the video title').replace('YouTube description', 'the YouTube description')}.`
}

function Person({ e }: { e: CreditEntry }) {
  const nav = useNavigate()
  const internal = e.person && LINKABLE.has(e.group)
  return (
    <div className="cr-row">
      <span className="cr-role">{e.role}</span>
      <span className="cr-name">
        {internal ? <button className="link" onClick={() => nav(`/artist/${encodeURIComponent(e.name)}`)}>{e.name}</button> : <span>{e.name}</span>}
        {e.link && <a className="cr-ext" href={e.link} target="_blank" rel="noreferrer" aria-label={`${e.name} on ${e.source ?? 'the web'}`}><Icon name="external" size={13} /></a>}
      </span>
    </div>
  )
}

/** Song credits: composer, lyricist, singers, producers, the film's director and cast — each linking out. */
export default function CreditsPage() {
  const { id: raw = '' } = useParams()
  const id = decodeURIComponent(raw)
  const nav = useNavigate()
  const track: Track | undefined = trackRegistry.get(id) ?? (id.startsWith('yt:') ? { id, title: '', artist: '', playbackRef: id.slice(3), album: null, durationMs: null } as unknown as Track : undefined)
  const data = useAsync(async () => (track ? fetchCredits(track) : null), [id])
  const cover = track ? artworkFor(track) : null
  const palette = usePaletteFor(cover)
  usePageTheme(palette)
  const groups = useMemo(() => groupCredits(data.data?.entries ?? []).filter((g) => g.group !== 'FILM' || !data.data?.film), [data.data])
  const filmCredits = (data.data?.entries ?? []).filter((e) => e.group === 'FILM')
  const film = data.data?.film
  const title = track?.title || data.data?.parsed?.title || 'Song'

  if (!track) return <div className="page"><Notice tone="warn">This song isn’t in your library or recent searches.</Notice></div>
  return (
    <div className="page playlist-page credits-page">
      <div className="pl-tint" style={{ ['--t1' as string]: palette.bg[0], ['--t2' as string]: palette.vivid }} />
      <header className="pl-hero">
        <motion.div className="hero-cover" initial={{ scale: 0.92, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: 'spring', stiffness: 220, damping: 24 }}>
          <div className="hero-cover-inner"><Artwork src={cover} seed={track.artist} hi /></div>
        </motion.div>
        <div className="pl-hero-text">
          <div className="t-eyebrow">Credits</div>
          <h1 className="t-hero pl-title">{title}</h1>
          {track.artist && <p className="t-sub pl-desc"><ArtistLinks track={track} /></p>}
          <div className="t-caption" style={{ marginTop: 8 }}>
            {track.album && <><button className="link" onClick={() => nav(`/album/${encodeURIComponent(track.album!)}?a=${encodeURIComponent(track.artist)}`)}>{track.album}</button>{' · '}</>}
            {data.data?.video?.published?.slice(0, 4) ?? track.year ?? ''}
          </div>
          <div className="row pl-actions">
            <button className="btn btn-primary btn-lg" onClick={() => player().play([track], 0, { context: 'Credits' })}><Icon name="play" size={16} /> Play</button>
            {data.data?.audio?.bpm && <span className="chip static"><Icon name="wave" size={14} /> {Math.round(data.data.audio.bpm)} BPM</span>}
            {data.data?.audio?.gainDb != null && <span className="chip static" title="Loudness (Deezer)">{data.data.audio.gainDb.toFixed(1)} dB</span>}
          </div>
        </div>
      </header>

      {data.loading && !data.data ? <section className="section"><SkeletonRows n={8} /></section> : null}
      {data.error ? <Notice tone="warn">Credits couldn’t load right now.</Notice> : null}

      {film && (
        <motion.section className="section film-card glass" initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }}>
          <div className="film-poster">{film.image ? <img src={film.image} alt="" loading="lazy" /> : <Icon name="film" size={34} />}</div>
          <div className="film-body">
            <div className="t-eyebrow">From the film</div>
            <div className="film-title">{film.title}{film.year ? <span className="t-caption"> · {film.year}</span> : null}</div>
            {film.description && <div className="t-caption" style={{ marginBottom: 10 }}>{film.description}</div>}
            {filmCredits.filter((e) => e.role === 'Director' || e.role === 'Video director').length > 0 && (
              <div className="film-line"><span className="cr-role">Directed by</span> {filmCredits.filter((e) => /director/i.test(e.role)).map((e, i) => <span key={e.name}>{i > 0 && ', '}{e.link ? <a className="link" href={e.link} target="_blank" rel="noreferrer">{e.name}</a> : e.name}</span>)}</div>
            )}
            {filmCredits.some((e) => e.role === 'Cast') && (
              <div className="film-cast">
                {filmCredits.filter((e) => e.role === 'Cast').slice(0, 10).map((e) => e.link
                  ? <a key={e.name} className="chip" href={e.link} target="_blank" rel="noreferrer">{e.name}</a>
                  : <span key={e.name} className="chip static">{e.name}</span>)}
              </div>
            )}
            {filmCredits.filter((e) => !/director|cast/i.test(e.role)).length > 0 && (
              <div className="film-line t-caption">{filmCredits.filter((e) => !/director|cast/i.test(e.role)).map((e) => `${e.role}: ${e.name}`).join(' · ')}</div>
            )}
            <div className="row" style={{ marginTop: 12, flexWrap: 'wrap' }}>
              <button className="btn btn-secondary btn-sm" onClick={() => nav(`/album/${encodeURIComponent(film.title)}?a=${encodeURIComponent(track.artist)}`)}><Icon name="album" size={15} /> Soundtrack</button>
              {film.wiki && <a className="btn btn-ghost btn-sm" href={film.wiki} target="_blank" rel="noreferrer">Wikipedia <Icon name="external" size={13} /></a>}
              {film.imdb && <a className="btn btn-ghost btn-sm" href={film.imdb} target="_blank" rel="noreferrer">IMDb <Icon name="external" size={13} /></a>}
            </div>
          </div>
        </motion.section>
      )}

      {groups.map((g, gi) => (
        <motion.section key={g.group} className="section cr-group" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.04 * gi }}>
          <h2 className="t-section">{g.title}</h2>
          <div className="cr-list">{g.entries.map((e) => <Person key={`${e.role}|${e.name}`} e={e} />)}</div>
        </motion.section>
      ))}

      {data.data && (
        <section className="section">
          <div className="t-caption">{sourceLine(data.data)} Credits are as published by the uploader and open databases; names link to their pages.</div>
          {data.data.mbid && <a className="link t-caption" href={`https://musicbrainz.org/recording/${data.data.mbid}`} target="_blank" rel="noreferrer">This recording on MusicBrainz</a>}
        </section>
      )}
    </div>
  )
}
