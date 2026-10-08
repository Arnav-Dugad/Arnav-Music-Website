import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion } from 'motion/react'
import { Icon } from './Icon'
import { useLibrary, liveEvents } from '../state/library'
import { trackRegistry } from '../state/tracks'
import { player } from '../state/player'
import { idbGet } from '../lib/idb'
import { credited } from '../lib/trust'
import type { ItunesItem } from '../lib/meta'
import type { Track } from '../lib/types'

interface Year { year: number; albums: ItunesItem[]; loved: Track[]; plays: number }
const strip = (s: string) => s.replace(/\s*-\s*(single|ep)$/i, '').replace(/\s*\((?:original\s+)?(?:motion\s+picture\s+)?soundtrack\)\s*$/i, '')

/** An artist's releases by year, with the songs you love marked and your own era highlighted. */
export function ArtistEras({ name, disco }: { name: string; disco: ItunesItem[] }) {
  const nav = useNavigate()
  const likes = useLibrary((s) => s.likes)
  const events = useLibrary((s) => s.events)
  const lovedTracks = useMemo(() => trackRegistry.many(Object.keys(likes)).filter((t) => credited(t, name)), [likes, name])
  // Release year and album of each loved song, from its Apple Music match when known.
  const [facts, setFacts] = useState<Map<string, { year: number | null; collectionId: number | null }>>(new Map())
  useEffect(() => {
    let alive = true
    void Promise.all(lovedTracks.map(async (t) => {
      const hit = await idbGet<{ item: ItunesItem | null }>(`itm|v3|${t.id}`, 'cache')
      return [t.id, { year: hit?.item?.releaseDate ? Number(hit.item.releaseDate.slice(0, 4)) : t.year ?? null, collectionId: hit?.item?.collectionId ?? null }] as const
    })).then((rows) => { if (alive) setFacts(new Map(rows)) })
    return () => { alive = false }
  }, [lovedTracks])

  const years = useMemo(() => {
    const m = new Map<number, Year>()
    const get = (y: number) => { const v = m.get(y) ?? { year: y, albums: [], loved: [], plays: 0 }; m.set(y, v); return v }
    for (const a of disco) { const y = Number(a.releaseDate?.slice(0, 4)); if (y > 1900) get(y).albums.push(a) }
    for (const t of lovedTracks) { const y = facts.get(t.id)?.year ?? t.year; if (y && y > 1900) get(y).loved.push(t) }
    for (const e of liveEvents(events)) {
      const t = trackRegistry.get(e.trackId)
      if (!t || !credited(t, name)) continue
      const y = facts.get(t.id)?.year ?? t.year
      if (y && m.has(y)) m.get(y)!.plays++
    }
    return [...m.values()].sort((a, b) => a.year - b.year)
  }, [disco, lovedTracks, facts, events, name])

  const lovedAlbum = (a: ItunesItem) => lovedTracks.filter((t) => (a.collectionId && facts.get(t.id)?.collectionId === a.collectionId) || (t.album && strip(a.title ?? '').toLowerCase() === strip(t.album).toLowerCase())).length
  const yourEra = years.reduce<Year | null>((best, y) => (y.plays > (best?.plays ?? 0) ? y : best), null)
  if (years.length < 2) return null
  return (
    <section className="section">
      <div className="section-head"><div><h2>Eras</h2><div className="t-sub">{yourEra && yourEra.plays > 2 ? `Your era: ${yourEra.year}` : 'Releases by year'}{lovedTracks.length ? ` · ${lovedTracks.length} ${lovedTracks.length === 1 ? 'song you love' : 'songs you love'} marked` : ''}</div></div></div>
      <div className="eras" role="list">
        {years.map((y, i) => (
          <motion.div key={y.year} role="listitem" className={`era ${yourEra?.year === y.year && y.plays > 2 ? 'yours' : ''}`} initial={{ opacity: 0, y: 12 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: '-40px' }} transition={{ delay: Math.min(i, 8) * 0.04 }}>
            <div className="era-year"><span>{y.year}</span><i /></div>
            <div className="era-items">
              {y.albums.slice(0, 4).map((a) => {
                const n = lovedAlbum(a)
                return (
                  <button key={a.collectionId} className="era-album" onClick={() => nav(`/album/${encodeURIComponent(a.title!)}?a=${encodeURIComponent(a.artist ?? name)}&it=${a.collectionId}`)} title={a.title ?? ''}>
                    <span className="era-cover">{a.artwork ? <img src={a.artwork.replace('1200x1200', '300x300')} alt="" loading="lazy" /> : null}{n > 0 && <span className="era-heart"><Icon name="heartFill" size={11} /> {n}</span>}</span>
                    <span className="era-title ellipsis">{strip(a.title ?? '')}</span>
                    <span className="t-caption">{(a.trackCount ?? 0) > 3 ? 'Album' : 'Single'}</span>
                  </button>
                )
              })}
              {y.albums.length > 4 && <span className="t-caption">+{y.albums.length - 4} more</span>}
              {y.loved.length > 0 && (
                <div className="era-loved">
                  {y.loved.slice(0, 4).map((t) => (
                    <button key={t.id} className="era-song" onClick={() => player().play([t], 0, { context: `${name} · ${y.year}` })}><Icon name="heartFill" size={11} /> <span className="ellipsis">{t.title}</span></button>
                  ))}
                </div>
              )}
            </div>
          </motion.div>
        ))}
      </div>
    </section>
  )
}
