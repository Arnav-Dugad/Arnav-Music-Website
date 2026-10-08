import { useMemo, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { motion } from 'motion/react'
import { Empty, Notice, SkeletonRows, Artwork, Spinner } from '../components/ui'
import { Icon } from '../components/Icon'
import { TrackList, splitArtists } from '../components/TrackRow'
import { useAsync, usePaletteFor, usePageTheme, useRegistryVersion } from '../hooks'
import { playlistTracks, search } from '../lib/youtube'
import { artworkFor, isSingle, titleSimilarity } from '../lib/classify'
import { duration, longDuration, plural, tidyTitle } from '../lib/format'
import { normalize } from '../lib/query'
import { MusicError, type Track } from '../lib/types'
import { artistOverlap, itunesAlbum, itunesAlbumSearch, VARIANT, type ItunesItem } from '../lib/meta'
import { addKnownFilm } from '../lib/knownArtists'
import { trackRegistry } from '../state/tracks'
import { player } from '../state/player'
import { lib, useLibrary } from '../state/library'
import { toast } from '../state/ui'
import { verified } from '../services/catalog'
import { isMorphing } from '../lib/reveal'

const SOUNDTRACK = /\s*[([](?:original\s+)?(?:motion\s+picture\s+)?(?:soundtrack|ost)[^)\]]*[)\]]\s*$/i
const albumBase = (s: string) => s.replace(SOUNDTRACK, '').replace(/\s*-\s*(single|ep)$/i, '').trim()
const sameAlbum = (a: string | null | undefined, b: string) => !!a && (normalize(albumBase(a)) === normalize(albumBase(b)) || titleSimilarity(albumBase(a), albumBase(b)) >= 0.85)
const songKey = (s: string) => normalize(tidyTitle(s.replace(/\s*[([](?:from|feat\.?|ft\.?|with)\b[^)\]]*[)\]]/gi, ''))).replace(/\s+/g, '')

/** Picks the iTunes album for a name (+ artist): same title, shared artist, most tracks. */
async function findItunesAlbum(name: string, artist: string, id: number | null): Promise<{ album: ItunesItem | null; tracks: ItunesItem[] }> {
  if (id) return itunesAlbum(id)
  const results = await itunesAlbumSearch(artist ? `${albumBase(name)} ${artist.split(',')[0]}` : albumBase(name), 15).catch(() => [])
  const best = results
    .filter((a) => a.title && sameAlbum(a.title, name) && (!artist || !a.artist || artistOverlap(a.artist, artist) || /soundtrack/i.test(a.title)))
    .sort((a, b) => Number(/single$/i.test(a.title ?? '')) - Number(/single$/i.test(b.title ?? '')) || (b.trackCount ?? 0) - (a.trackCount ?? 0))[0]
  return best?.collectionId ? itunesAlbum(best.collectionId) : { album: null, tracks: [] }
}

/** An album playlist from the artist's own channel (or its Topic / VEVO channel) — never a fan's. */
function officialAlbumPlaylist(p: { id: string; name: string; owner: string }, title: string, artist: string): boolean {
  const owner = p.owner.replace(/\s*-\s*Topic$/i, '').replace(/VEVO$/i, '').trim()
  const own = !!owner && !!artist && (artistOverlap(owner, artist) || p.id.startsWith('ytpl:OLAK5uy_'))
  if (!own) return false
  const name = p.name.replace(/^album\s*-\s*/i, '')
  const base = albumBase(title).replace(/\s*[([].*?[)\]]\s*/g, ' ').trim()
  return sameAlbum(name, title) || (!!base && name.toLowerCase().includes(base.toLowerCase()))
}

/** Best official upload for one album track (same song, shared artist, closest length). */
function matchTrack(it: ItunesItem, pool: Track[]): Track | null {
  const key = songKey(it.title ?? '')
  const wantVariant = VARIANT.test(it.title ?? '')
  const cands = pool.filter((t) => {
    const k = songKey(t.title)
    if (!k || !key) return false
    const same = k === key || titleSimilarity(tidyTitle(t.title), it.title ?? '') >= 0.85
    return same && (wantVariant || !VARIANT.test(t.rawTitle ?? t.title)) && (!it.artist || artistOverlap(it.artist, `${t.artist}, ${t.credits ?? ''}`) || t.album != null)
  })
  return cands.sort((a, b) => (b.trust ?? 1) - (a.trust ?? 1) || Math.abs((a.durationMs ?? 0) - (it.durationMs ?? 0)) - Math.abs((b.durationMs ?? 0) - (it.durationMs ?? 0)))[0] ?? null
}

/**
 * An album or film soundtrack. With iTunes we know the exact tracklist; each song is matched to an
 * official upload (the artist's Topic album playlist first, then label uploads). Without it, the
 * album is assembled from label uploads that name it ("Song - Movie | Cast | Singers").
 */
export default function AlbumPage() {
  const { name: raw = '' } = useParams()
  const [params] = useSearchParams()
  const nav = useNavigate()
  const name = decodeURIComponent(raw)
  const artist = params.get('a') ?? ''
  const itId = Number(params.get('it')) || null
  const v = useRegistryVersion()
  const [finding, setFinding] = useState<string | null>(null)

  const info = useAsync(() => findItunesAlbum(name, artist, itId), [name, artist, itId])
  const it = info.data?.album ?? null
  const title = it?.title ? albumBase(it.title) : name
  const albumArtist = it?.artist ?? artist

  const found = useAsync(async () => {
    if (info.loading) return null
    if (it?.title && /soundtrack/i.test(it.title)) addKnownFilm(title)
    const pools: Track[] = []
    // 1. The artist's auto-generated album playlist (Topic) — exact, official audio.
    if (it) {
      const pl = await search(`${title} ${albumArtist.split(',')[0]}`, 'PLAYLISTS').catch(() => null)
      const album = pl?.playlists.find((p) => officialAlbumPlaylist(p, it.title ?? title, albumArtist))
      if (album) pools.push(...(await playlistTracks(album.id.slice(5)).catch(() => [])))
    }
    // 2. Label uploads that name the album / film.
    if (!pools.length || (info.data?.tracks.length ?? 0) > pools.length) {
      const first = await search(`${title} songs`, 'SONGS').catch(() => null)
      pools.push(...(first?.tracks ?? []))
      const matched = (first?.tracks ?? []).filter((t) => sameAlbum(t.album, title)).length
      if (matched < 5 && albumArtist) pools.push(...((await search(`${title} ${albumArtist.split(',')[0]}`, 'SONGS').catch(() => null))?.tracks ?? []))
      // Still short of the tracklist: the artist's Topic art tracks (official audio for every album song).
      const list = info.data?.tracks ?? []
      const covered = list.filter((x) => matchTrack(x, pools)).length
      if (list.length >= 4 && covered < list.length * 0.7) pools.push(...((await search(`${albumArtist.split(',')[0]} ${title} topic`, 'SONGS').catch(() => null))?.tracks ?? []))
    }
    if (!pools.length && !it) throw new MusicError('http', 'Songs for this album couldn’t load.')
    return pools
  }, [title, albumArtist, info.loading])

  const mine = useLibrary((s) => s.likes)
  const { rows, missing } = useMemo(() => {
    const s = useLibrary.getState()
    const ids = new Set<string>([...Object.keys(mine), ...Object.values(s.playlists).filter((p) => !p.deleted).flatMap((p) => p.trackIds), ...s.events.map((e) => e.trackId)])
    const cached = trackRegistry.all().filter((t) => !!t.rawTitle || ids.has(t.id))
    const pool = verified([...(found.data ?? []), ...cached]).filter(isSingle)
    const list = info.data?.tracks ?? []
    if (list.length) {
      const used = new Set<string>()
      const out: Track[] = []
      const miss: ItunesItem[] = []
      for (const item of list) {
        const t = matchTrack(item, pool.filter((p) => !used.has(p.id)))
        if (t) { used.add(t.id); out.push({ ...t, album: title, year: t.year ?? (it?.releaseDate ? Number(it.releaseDate.slice(0, 4)) : null) }) } else miss.push(item)
      }
      return { rows: out, missing: miss }
    }
    // No tracklist: one version per song from uploads that name this album.
    const bySong = new Map<string, Track>()
    for (const t of pool.filter((x) => sameAlbum(x.album, title))) {
      const k = songKey(t.title)
      const prev = bySong.get(k)
      if (!prev || (t.trust ?? 1) > (prev.trust ?? 1) || ((t.trust ?? 1) === (prev.trust ?? 1) && (t.views ?? 0) > (prev.views ?? 0))) bySong.set(k, t)
    }
    return { rows: [...bySong.values()].sort((a, b) => (b.views ?? 0) - (a.views ?? 0)), missing: [] as ItunesItem[] }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [found.data, info.data, title, v, mine])

  const cover = it?.artwork ?? (rows[0] ? artworkFor(rows[0]) : null)
  const palette = usePaletteFor(cover)
  usePageTheme(palette)
  const singers = useMemo(() => [...new Set([...(it?.artist ? splitArtists(it.artist) : []), ...rows.flatMap((t) => splitArtists(t.artist))])].slice(0, 6), [rows, it])
  const total = rows.reduce((a, t) => a + (t.durationMs ?? 0), 0)
  const year = it?.releaseDate?.slice(0, 4) ?? rows.map((t) => t.year).filter((y): y is number => !!y).sort()[0]
  const soundtrack = /soundtrack|ost/i.test(it?.title ?? '') || rows.some((t) => t.channelTitle && /t-series|zee music|sony music india|tips|saregama|yrf/i.test(t.channelTitle))

  /** One search for a song the album has but we haven't matched yet. */
  const findOne = async (item: ItunesItem) => {
    setFinding(item.title)
    try {
      const r = await search(`${item.title} ${item.artist?.split(',')[0] ?? albumArtist}`, 'SONGS')
      const t = matchTrack(item, verified(r.tracks))
      if (t) player().play([t], 0, { context: title })
      else toast('No official upload of this song found')
    } catch { toast('Couldn’t search right now') } finally { setFinding(null) }
  }

  const loading = (info.loading || found.loading) && !rows.length
  return (
    <div className="page playlist-page">
      <div className="pl-tint" style={{ ['--t1' as string]: palette.bg[0], ['--t2' as string]: palette.vivid }} />
      <header className="pl-hero">
        <motion.div className="hero-cover" style={{ viewTransitionName: 'cover' }} initial={isMorphing() ? false : { scale: 0.92, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: 'spring', stiffness: 220, damping: 24 }}>
          <div className="hero-cover-inner album-cover"><Artwork src={cover} seed={title} icon="album" hi /></div>
        </motion.div>
        <div className="pl-hero-text">
          <div className="t-eyebrow">{soundtrack ? 'Album · Soundtrack' : it?.trackCount === 1 ? 'Single' : 'Album'}{it?.genre ? ` · ${it.genre}` : ''}</div>
          <h1 className="t-hero pl-title">{title}</h1>
          {singers.length > 0 && (
            <p className="t-sub pl-desc">
              {singers.map((s, i) => <span key={s}>{i > 0 && ', '}<button className="link" onClick={() => nav(`/artist/${encodeURIComponent(s)}`)}>{s}</button></span>)}
            </p>
          )}
          <div className="t-caption" style={{ marginTop: 8 }}>
            {plural(rows.length, 'song')}{missing.length ? ` of ${rows.length + missing.length}` : ''}{total ? ` · ${longDuration(total)}` : ''}{year ? ` · ${year}` : ''} · official uploads{it ? ' · tracklist from Apple Music' : ''}
          </div>
          <div className="row pl-actions">
            <button className="btn btn-primary btn-lg" disabled={!rows.length} onClick={() => player().play(rows, 0, { context: title, contextId: `album:${title}`, shuffle: false })}><Icon name="play" size={16} /> Play</button>
            <button className="btn btn-secondary btn-lg" disabled={!rows.length} onClick={() => player().play(rows, 0, { context: title, contextId: `album:${title}`, shuffle: true })}><Icon name="shuffle" size={16} /> Shuffle</button>
            <button className="icon-btn" aria-label="Save as playlist" title="Save as playlist" disabled={!rows.length} onClick={() => { const id = lib().createPlaylist(title, rows, singers.join(', ')); toast('Saved to your playlists', { label: 'Open', run: () => nav(`/playlist/${id}`) }) }}><Icon name="plus" size={19} /></button>
            {it?.url && <a className="icon-btn" href={it.url} target="_blank" rel="noreferrer" aria-label="Open in Apple Music" title="Open in Apple Music"><Icon name="external" size={17} /></a>}
          </div>
        </div>
      </header>
      <section className="section" style={{ marginTop: 28 }}>
        {loading ? <SkeletonRows n={8} /> : found.error && !rows.length ? (
          <Notice tone="warn">{found.error instanceof MusicError ? found.error.message : 'This album couldn’t load.'}</Notice>
        ) : rows.length ? <TrackList tracks={rows} context={title} showAlbum={false} /> : !missing.length ? <Empty icon="album" title="No official songs found for this album" /> : null}
      </section>
      {missing.length > 0 && (
        <section className="section">
          <h2 className="t-section">More from this album</h2>
          <div className="t-caption" style={{ marginBottom: 10 }}>On the album, but no official upload matched yet — tap to look.</div>
          <div className="album-missing">
            {missing.map((m) => (
              <button key={`${m.discNumber}-${m.trackNumber}-${m.title}`} className="album-missing-row" disabled={finding === m.title} onClick={() => void findOne(m)}>
                <span className="t-caption tnum">{m.trackNumber}</span>
                <span className="grow ellipsis"><b>{m.title}</b> <span className="t-caption">· {m.artist}</span></span>
                <span className="t-caption tnum">{m.durationMs ? duration(m.durationMs) : ''}</span>
                {finding === m.title ? <Spinner size={14} /> : <Icon name="search" size={15} />}
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
