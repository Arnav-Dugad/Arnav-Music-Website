import { useEffect, useState } from 'react'
import { Icon } from './Icon'
import { itunesMatch, type CreditsResult, type ItunesItem } from '../lib/meta'
import { duration as fmt } from '../lib/format'
import type { Track } from '../lib/types'

/**
 * One recording, everywhere: the ISRC (the industry's id for a recording) links this YouTube upload
 * to Deezer and MusicBrainz exactly; Apple Music is linked when its recording has the same length.
 */
export function SongIdentity({ track, credits }: { track: Track; credits: CreditsResult | null }) {
  const [apple, setApple] = useState<ItunesItem | null>(null)
  useEffect(() => { void itunesMatch(track).then(setApple).catch(() => setApple(null)) }, [track.id]) // eslint-disable-line react-hooks/exhaustive-deps
  const id = credits?.identity
  if (!id && !apple) return null
  const dz = id?.deezer
  const sameLength = !!(apple?.durationMs && dz?.durationMs && Math.abs(apple.durationMs - dz.durationMs) <= 2000)
  const rows: { name: string; status: 'exact' | 'match' | 'video'; detail: string; link: string | null }[] = [
    { name: 'YouTube', status: 'video', detail: `${track.variant === 'SONG' ? 'Official audio' : 'Upload'} · ${fmt(track.durationMs)}`, link: `https://www.youtube.com/watch?v=${track.playbackRef}` },
    ...(dz ? [{ name: 'Deezer', status: 'exact' as const, detail: `Same ISRC${dz.durationMs ? ` · ${fmt(dz.durationMs)}` : ''}`, link: dz.link }] : []),
    ...(id?.musicbrainz ? [{ name: 'MusicBrainz', status: 'exact' as const, detail: 'Same ISRC · open recording database', link: `https://musicbrainz.org/recording/${id.musicbrainz}` }] : []),
    ...(apple ? [{ name: 'Apple Music', status: sameLength ? 'exact' as const : 'match' as const, detail: `${sameLength ? 'Same recording (length matches)' : 'Closest match'} · ${fmt(apple.durationMs)}${apple.album ? ` · ${apple.album}` : ''}`, link: apple.url }] : []),
  ]
  return (
    <section className="section">
      <h2 className="t-section">Song identity</h2>
      <div className="ident glass">
        {id && (
          <div className="ident-isrc">
            <span className="t-caption">ISRC</span>
            <span className="mono ident-code">{id.isrc.replace(/^(..)(...)(..)(.+)$/, '$1-$2-$3-$4')}</span>
            {id.from && <span className="t-caption">from {id.from}</span>}
          </div>
        )}
        <div className="ident-rows">
          {rows.map((r) => (
            <a key={r.name} className={`ident-row ${r.status}`} href={r.link ?? undefined} target="_blank" rel="noreferrer">
              <span className={`ident-dot ${r.status}`} aria-hidden />
              <span className="grow"><b>{r.name}</b><span className="t-caption"> · {r.detail}</span></span>
              {r.link && <Icon name="external" size={14} />}
            </a>
          ))}
        </div>
        <div className="t-caption">{id ? 'Linked by ISRC, so these are the same recording — not just the same title.' : 'No ISRC published for this upload; Apple Music is matched by title, artist and length.'}</div>
      </div>
    </section>
  )
}
