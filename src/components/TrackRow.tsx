import { memo, type MouseEvent, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { Artwork, Eq } from './ui'
import { Icon } from './Icon'
import { duration } from '../lib/format'
import { artworkFor } from '../lib/classify'
import type { Track } from '../lib/types'
import { usePlayer, player } from '../state/player'
import { useLibrary } from '../state/library'
import { ui, toast } from '../state/ui'

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

export function LikeButton({ track, size = 18, className = '' }: { track: Track; size?: number; className?: string }) {
  const liked = useLibrary((s) => !!s.likes[track.id] && !s.likes[track.id].deleted)
  return (
    <button
      className={`icon-btn sm like ${liked ? 'on liked' : ''} ${className}`}
      aria-label={liked ? 'Remove from Liked Songs' : 'Add to Liked Songs'}
      aria-pressed={liked}
      onClick={(e) => {
        e.stopPropagation()
        const now = useLibrary.getState().toggleLike(track)
        if (now) toast('Added to Liked Songs')
      }}
    >
      <Icon name={liked ? 'heartFill' : 'heart'} size={size} />
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
  const play = () => {
    if (onPlay) return onPlay()
    if (isCurrent) return player().toggle()
    player().play(list, index, { context })
  }
  return (
    <div
      className={`track-row ${isCurrent ? 'current' : ''} ${compact ? 'compact' : ''}`}
      onClick={(e) => { if (!(e.target as HTMLElement).closest('button')) play() }}
      onContextMenu={(e) => openTrackMenu(e, track, { playlistId })}
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
          <button className="link" onClick={(e) => { e.stopPropagation(); nav(`/artist/${encodeURIComponent(track.artist)}${track.channelId ? `?c=${track.channelId}` : ''}`) }}>{track.artist}</button>
          {caption && <span className="tr-caption"> · {caption}</span>}
        </div>
      </div>
      {showAlbum && <div className="tr-album ellipsis hide-sm">{track.album ?? ''}</div>}
      <div className="tr-right">
        {right}
        <LikeButton track={track} />
        <span className="tr-dur tabular hide-xs">{duration(track.durationMs)}</span>
        <button className="icon-btn sm" aria-label="More" onClick={(e) => openTrackMenu(e, track, { playlistId })}><Icon name="more" size={18} /></button>
      </div>
    </div>
  )
})

export function TrackList({ tracks, context, number = true, showAlbum = true, captions, playlistId }: { tracks: Track[]; context?: string; number?: boolean; showAlbum?: boolean; captions?: Record<string, ReactNode>; playlistId?: string }) {
  return (
    <div className="track-list">
      {tracks.map((t, i) => (
        <TrackRow key={`${t.id}-${i}`} track={t} index={i} list={tracks} context={context} number={number} showAlbum={showAlbum} caption={captions?.[t.id]} playlistId={playlistId} />
      ))}
    </div>
  )
}
