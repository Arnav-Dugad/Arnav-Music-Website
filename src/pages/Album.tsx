import { useMemo } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { motion } from 'motion/react'
import { Empty, Notice, SkeletonRows } from '../components/ui'
import { Icon } from '../components/Icon'
import { TrackList, splitArtists } from '../components/TrackRow'
import { useAsync, usePaletteFor, useRegistryVersion } from '../hooks'
import { search } from '../lib/youtube'
import { artworkFor, isSingle, titleSimilarity } from '../lib/classify'
import { longDuration, plural, tidyTitle } from '../lib/format'
import { normalize } from '../lib/query'
import { MusicError, type Track } from '../lib/types'
import { trackRegistry } from '../state/tracks'
import { player } from '../state/player'
import { lib, useLibrary } from '../state/library'
import { toast } from '../state/ui'
import { verified } from '../services/catalog'
import { Artwork } from '../components/ui'

const sameAlbum = (a: string | null | undefined, b: string) => !!a && (normalize(a) === normalize(b) || titleSimilarity(a, b) >= 0.85)

/**
 * An album or film soundtrack, assembled from official uploads: label uploads name the film
 * ("Song - Movie | Cast | Singers"), Topic uploads carry the album. One version per song.
 */
export default function AlbumPage() {
  const { name: raw = '' } = useParams()
  const [params] = useSearchParams()
  const nav = useNavigate()
  const name = decodeURIComponent(raw)
  const artist = params.get('a') ?? ''
  const v = useRegistryVersion()
  const found = useAsync(async () => {
    const first = await search(`${name} songs`, 'SONGS').catch(() => null)
    const matched = (first?.tracks ?? []).filter((t) => sameAlbum(t.album, name)).length
    // A second, artist-qualified search only when the first found few songs from this album.
    const second = matched >= 5 || !artist ? null : await search(`${name} ${artist}`, 'SONGS').catch(() => null)
    if (!first && !second) throw new MusicError('http', 'Songs for this album couldn’t load.')
    return [...(first?.tracks ?? []), ...(second?.tracks ?? [])]
  }, [name, artist])

  const tracks = useMemo(() => {
    // Cached tracks join only when they were parsed from their YouTube title or are in your library.
    const s = useLibrary.getState()
    const mine = new Set<string>([...Object.keys(s.likes), ...Object.values(s.playlists).filter((p) => !p.deleted).flatMap((p) => p.trackIds), ...s.events.map((e) => e.trackId)])
    const cached = trackRegistry.all().filter((t) => !!t.rawTitle || mine.has(t.id))
    const pool = verified([...(found.data ?? []), ...cached]).filter((t) => isSingle(t) && sameAlbum(t.album, name))
    const bySong = new Map<string, Track>()
    for (const t of pool) {
      const k = normalize(tidyTitle(t.title)).replace(/\s+/g, '')
      const prev = bySong.get(k)
      if (!prev || (t.trust ?? 1) > (prev.trust ?? 1) || ((t.trust ?? 1) === (prev.trust ?? 1) && (t.views ?? 0) > (prev.views ?? 0))) bySong.set(k, t)
    }
    return [...bySong.values()].sort((a, b) => (b.views ?? 0) - (a.views ?? 0))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [found.data, name, v])

  const cover = tracks[0] ? artworkFor(tracks[0]) : null
  const palette = usePaletteFor(cover)
  const singers = useMemo(() => [...new Set(tracks.flatMap((t) => splitArtists(t.artist)))].slice(0, 6), [tracks])
  const total = tracks.reduce((a, t) => a + (t.durationMs ?? 0), 0)
  const year = tracks.map((t) => t.year).filter((y): y is number => !!y).sort()[0]

  return (
    <div className="page playlist-page">
      <div className="pl-tint" style={{ ['--t1' as string]: palette.bg[0], ['--t2' as string]: palette.vivid }} />
      <header className="pl-hero">
        <motion.div className="hero-cover" initial={{ scale: 0.92, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: 'spring', stiffness: 220, damping: 24 }}>
          <div className="hero-cover-inner album-cover"><Artwork src={cover} seed={name} icon="album" hi /></div>
        </motion.div>
        <div className="pl-hero-text">
          <div className="t-eyebrow">Album · Soundtrack</div>
          <h1 className="t-hero pl-title">{name}</h1>
          {singers.length > 0 && (
            <p className="t-sub pl-desc">
              {singers.map((s, i) => <span key={s}>{i > 0 && ', '}<button className="link" onClick={() => nav(`/artist/${encodeURIComponent(s)}`)}>{s}</button></span>)}
            </p>
          )}
          <div className="t-caption" style={{ marginTop: 8 }}>{plural(tracks.length, 'song')}{total ? ` · ${longDuration(total)}` : ''}{year ? ` · ${year}` : ''} · official uploads</div>
          <div className="row pl-actions">
            <button className="btn btn-primary btn-lg" disabled={!tracks.length} onClick={() => player().play(tracks, 0, { context: name, shuffle: false })}><Icon name="play" size={16} /> Play</button>
            <button className="btn btn-secondary btn-lg" disabled={!tracks.length} onClick={() => player().play(tracks, 0, { context: name, shuffle: true })}><Icon name="shuffle" size={16} /> Shuffle</button>
            <button className="icon-btn" aria-label="Save as playlist" title="Save as playlist" disabled={!tracks.length} onClick={() => { const id = lib().createPlaylist(name, tracks, singers.join(', ')); toast('Saved to your playlists', { label: 'Open', run: () => nav(`/playlist/${id}`) }) }}><Icon name="plus" size={19} /></button>
          </div>
        </div>
      </header>
      <section className="section" style={{ marginTop: 28 }}>
        {found.loading && !tracks.length ? <SkeletonRows n={8} /> : found.error && !tracks.length ? (
          <Notice tone="warn">{found.error instanceof MusicError ? found.error.message : 'This album couldn’t load.'}</Notice>
        ) : tracks.length ? <TrackList tracks={tracks} context={name} showAlbum={false} /> : <Empty icon="album" title="No official songs found for this album" />}
      </section>
    </div>
  )
}
