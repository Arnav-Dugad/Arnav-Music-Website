import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { Artwork, Eq } from './ui'
import { Icon } from './Icon'
import { LikeButton, openTrackMenu, useNowPlaying } from './TrackRow'
import { artworkFor } from '../lib/classify'
import type { Track } from '../lib/types'
import { player } from '../state/player'
import type { Moment } from '../lib/moments'

/** Generated mix cover: a deep gradient in the mix's hue, a typographic title and a mosaic. */
export function MixArt({ title, hue, tracks, eyebrow = 'Arnav' }: { title: string; hue: number; tracks: Track[]; eyebrow?: string }) {
  const arts = useMemo(() => [...new Set(tracks.map((t) => artworkFor(t, 'sm')))].slice(0, 3), [tracks])
  return (
    <div className="mix-art card-art" style={{ ['--h' as string]: hue }}>
      <div className="mix-mosaic">
        {arts.map((a, i) => <Artwork key={a} src={a} letterbox={false} className={`mix-tile t${i}`} />)}
      </div>
      <div className="mix-shade" />
      <div className="mix-text">
        <span className="mix-eyebrow">{eyebrow}</span>
        <span className="mix-title">{title}</span>
      </div>
    </div>
  )
}

/** Procedural moment cover (no images): the moment's palette as a slow aurora. */
export function MomentArt({ m, large = false }: { m: Moment; large?: boolean }) {
  const [a, b, c] = m.palette
  return (
    <div className={`moment-art card-art ${large ? 'large' : ''} motion-${m.motion.toLowerCase()}`} style={{ ['--m1' as string]: a, ['--m2' as string]: b, ['--m3' as string]: c }}>
      <i className="ma-orb o1" /><i className="ma-orb o2" /><i className="ma-orb o3" />
      {m.motion === 'RAIN' && <span className="ma-rain" />}
      <div className="ma-text">
        <span className={`ma-title type-${m.type}`}>{m.title}</span>
        {large && <span className="ma-sub">{m.subtitle}</span>}
      </div>
    </div>
  )
}

/** YouTube Music–style "Quick picks": compact rows in columns that scroll sideways. */
export function QuickPicks({ tracks, context, captions }: { tracks: Track[]; context: string; captions?: Record<string, string> }) {
  const { id, playing } = useNowPlaying()
  const nav = useNavigate()
  const cols: Track[][] = []
  for (let i = 0; i < tracks.length; i += 4) cols.push(tracks.slice(i, i + 4))
  return (
    <div className="shelf-scroll qp">
      {cols.map((col, ci) => (
        <div className="qp-col" key={ci}>
          {col.map((t, ri) => {
            const idx = ci * 4 + ri
            const cur = id === t.id
            return (
              <div key={t.id} className={`qp-row ${cur ? 'current' : ''}`} onClick={() => (cur ? player().toggle() : player().play(tracks, idx, { context }))} onContextMenu={(e) => openTrackMenu(e, t)} role="button" tabIndex={0}>
                <div className="qp-art">
                  <Artwork src={artworkFor(t, 'sm')} letterbox={false} seed={t.artist} />
                  <span className="qp-ov">{cur ? <Eq playing={playing} /> : <Icon name="play" size={15} />}</span>
                </div>
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="qp-title ellipsis">{t.title}</div>
                  <div className="qp-sub ellipsis">
                    <button className="link" onClick={(e) => { e.stopPropagation(); nav(`/artist/${encodeURIComponent(t.artist)}`) }}>{t.artist}</button>
                    {captions?.[t.id] && <span className="subtle"> · {captions[t.id]}</span>}
                  </div>
                </div>
                <LikeButton track={t} size={16} />
                <button className="icon-btn sm" aria-label="More" onClick={(e) => openTrackMenu(e, t)}><Icon name="more" size={16} /></button>
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}
