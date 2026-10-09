import { memo, useEffect, useState, type MouseEvent, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { useNavigate } from 'react-router-dom'
import { Artwork, Eq } from './ui'
import { Icon } from './Icon'
import { duration } from '../lib/format'
import { artworkFor } from '../lib/classify'
import type { Track } from '../lib/types'
import { usePlayer, player } from '../state/player'
import { useLibrary } from '../state/library'
import { ui, toast } from '../state/ui'
import { usePreviewHold } from '../player/usePreviewHold'

/** Credited names ("Tanishk Bagchi, Asees Kaur" / "A & B" / "A feat. B") as separate artists. */
export function splitArtists(artist: string): string[] {
  return artist.split(/\s*,\s*|\s+&\s+|\s+x\s+|\s+feat\.?\s+|\s+ft\.?\s+/i).map((s) => s.trim()).filter(Boolean).slice(0, 4)
}

/** Artist page link. The uploader channel is only a hint when it *is* the artist (Topic / own channel). */
export function artistHref(track: Pick<Track, 'channelId' | 'trust' | 'channelTitle'>, name: string, single: boolean): string {
  const own = single && track.channelId && ((track.trust ?? 0) === 2 || /- Topic$/i.test(track.channelTitle ?? ''))
  return `/artist/${encodeURIComponent(name)}${own ? `?c=${track.channelId}` : ''}`
}

export const albumHref = (track: Pick<Track, 'album' | 'artist'>) =>
  `/album/${encodeURIComponent(track.album ?? '')}?a=${encodeURIComponent(splitArtists(track.artist)[0] ?? '')}`

export function ArtistLinks({ track, onNavigate }: { track: Track; onNavigate?: () => void }) {
  const nav = useNavigate()
  const names = splitArtists(track.artist)
  return (
    <>
      {names.map((n, i) => (
        <span key={n}>
          {i > 0 && ', '}
          <button className="link" onClick={(e) => { e.stopPropagation(); onNavigate?.(); nav(artistHref(track, n, names.length === 1)) }}>{n}</button>
        </span>
      ))}
      {(track.trust ?? 0) >= 2 && <span className="verified-badge" title={(track.trust ?? 0) === 3 ? 'Official upload' : 'Artist channel'} aria-label="Official"><Icon name="check" size={9} strokeWidth={3.4} /></span>}
    </>
  )
}

export function useNowPlaying() {
  const id = usePlayer((s) => s.queue[s.index]?.track.id ?? null)
  const playing = usePlayer((s) => s.isPlaying || (s.wantPlaying && s.isBuffering))
  return { id, playing }
}

export function openTrackMenu(e: MouseEvent, track: Track, extra: { playlistId?: string; queueKey?: string } = {}) {
  e.preventDefault()
  e.stopPropagation()
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
  const x = e.type === 'contextmenu' ? e.clientX : r.right
  const y = e.type === 'contextmenu' ? e.clientY : r.bottom
  ui().set({ menu: { track, x, y, ...extra } })
}

const BURST = Array.from({ length: 8 }, (_, i) => (i / 8) * Math.PI * 2)

/** A heart that fills from its centre with a small burst (the app's like animation). */
export function LikeButton({ track, size = 18, className = '' }: { track: Track; size?: number; className?: string }) {
  const liked = useLibrary((s) => !!s.likes[track.id] && !s.likes[track.id].deleted)
  const [burst, setBurst] = useState(0)
  return (
    <button
      className={`icon-btn sm like ${liked ? 'on liked' : ''} ${className}`}
      aria-label={liked ? 'Remove from Liked Songs' : 'Add to Liked Songs'}
      aria-pressed={liked}
      onClick={(e) => {
        e.stopPropagation()
        const now = useLibrary.getState().toggleLike(track)
        if (now) { setBurst((b) => b + 1); toast('Added to Liked Songs') }
      }}
    >
      <span className="heart-wrap" style={{ width: size, height: size }}>
        <Icon name="heart" size={size} />
        <motion.span className="heart-fill" initial={false} animate={{ scale: liked ? 1 : 0, opacity: liked ? 1 : 0 }} transition={{ type: 'spring', stiffness: 520, damping: liked ? 14 : 30 }}>
          <Icon name="heartFill" size={size} />
        </motion.span>
        <AnimatePresence>
          {burst > 0 && liked && (
            <motion.span key={burst} className="heart-burst" initial={{ opacity: 1 }} animate={{ opacity: 0 }} transition={{ duration: 0.7, delay: 0.15 }}>
              <motion.i className="heart-ring" initial={{ scale: 0.3, opacity: 0.9 }} animate={{ scale: 1.9, opacity: 0 }} transition={{ duration: 0.55, ease: 'easeOut' }} />
              {BURST.map((a, i) => (
                <motion.i key={i} className="heart-dot" initial={{ x: 0, y: 0, scale: 1 }} animate={{ x: Math.cos(a) * size * 0.95, y: Math.sin(a) * size * 0.95, scale: 0 }} transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }} />
              ))}
            </motion.span>
          )}
        </AnimatePresence>
      </span>
    </button>
  )
}

interface RowProps {
  track: Track
  index: number
  list: Track[]
  context?: string
  number?: boolean
  showAlbum?: boolean
  caption?: ReactNode
  playlistId?: string
  right?: ReactNode
  onPlay?: () => void
  compact?: boolean
}

export const TrackRow = memo(function TrackRow({ track, index, list, context, number, showAlbum = true, caption, playlistId, right, onPlay, compact }: RowProps) {
  const { id, playing } = useNowPlaying()
  const nav = useNavigate()
  const isCurrent = id === track.id
  const hold = usePreviewHold(track)
  const play = () => {
    if (onPlay) return onPlay()
    if (isCurrent) return player().toggle()
    player().play(list, index, { context })
  }
  return (
    <div
      className={`track-row ${isCurrent ? 'current' : ''} ${compact ? 'compact' : ''}`}
      onClick={(e) => { if (!(e.target as HTMLElement).closest('button')) hold.guard(play)?.() }}
      {...hold.handlers}
      onContextMenu={(e) => { if (hold.held()) { e.preventDefault(); return } openTrackMenu(e, track, { playlistId }) }}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter') play() }}
    >
      {number && (
        <div className="tr-num tabular">
          {isCurrent ? <Eq playing={playing} /> : <span className="n">{index + 1}</span>}
          <button className="tr-num-play" aria-label={`Play ${track.title}`} onClick={(e) => { e.stopPropagation(); play() }}>
            <Icon name={isCurrent && playing ? 'pause' : 'play'} size={14} />
          </button>
        </div>
      )}
      <div className="tr-art">
        <Artwork src={artworkFor(track, 'sm')} letterbox={false} seed={track.artist} />
        {!number && (
          <div className="tr-art-overlay">
            {isCurrent ? <Eq playing={playing} /> : <Icon name="play" size={16} />}
          </div>
        )}
      </div>
      <div className="tr-main">
        <div className="tr-title ellipsis">
          {track.title}
          {track.variant === 'VIDEO' && <span className="tr-tag">Video</span>}
        </div>
        <div className="tr-sub ellipsis">
          <ArtistLinks track={track} />
          {caption && <span className="tr-caption"> · {caption}</span>}
        </div>
      </div>
      {showAlbum && <div className="tr-album ellipsis hide-sm">{track.album ? <button className="link" onClick={(e) => { e.stopPropagation(); nav(albumHref(track)) }}>{track.album}</button> : ''}</div>}
      <div className="tr-right">
        {right}
        <LikeButton track={track} />
        <span className="tr-dur tabular hide-xs">{duration(track.durationMs)}</span>
        <button className="icon-btn sm" aria-label="More" onClick={(e) => openTrackMenu(e, track, { playlistId })}><Icon name="more" size={18} /></button>
      </div>
    </div>
  )
})

const FIRST_ROWS = 40

export function TrackList({ tracks, context, number = true, showAlbum = true, captions, playlistId }: { tracks: Track[]; context?: string; number?: boolean; showAlbum?: boolean; captions?: Record<string, ReactNode>; playlistId?: string }) {
  // Long lists paint the first rows straight away and add the rest in idle time, so a 200-song
  // playlist opens instantly instead of building every row up front.
  const [limit, setLimit] = useState(FIRST_ROWS)
  useEffect(() => {
    if (limit >= tracks.length) return
    const run = () => setLimit((n) => n + 80)
    if (typeof window.requestIdleCallback === 'function') {
      const h = window.requestIdleCallback(run, { timeout: 300 })
      return () => window.cancelIdleCallback(h)
    }
    const h = window.setTimeout(run, 60)
    return () => clearTimeout(h)
  }, [limit, tracks.length])
  return (
    <div className="track-list">
      {tracks.slice(0, limit).map((t, i) => (
        <TrackRow key={`${t.id}-${i}`} track={t} index={i} list={tracks} context={context} number={number} showAlbum={showAlbum} caption={captions?.[t.id]} playlistId={playlistId} />
      ))}
    </div>
  )
}
