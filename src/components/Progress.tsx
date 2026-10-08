import { useRef, useState, type PointerEvent } from 'react'
import { usePlayer, useProgress, player } from '../state/player'
import { duration as fmt } from '../lib/format'

/** Scrubbable progress with hover-grow, drag preview and buffered range. */
export function Progress({ variant = 'full', showTimes = true }: { variant?: 'full' | 'bar' | 'line'; showTimes?: boolean }) {
  const pos = useProgress((s) => s.position)
  const buffered = useProgress((s) => s.buffered)
  const dur = usePlayer((s) => s.duration || s.queue[s.index]?.track.durationMs || 0)
  const [drag, setDrag] = useState<number | null>(null)
  const [hover, setHover] = useState<number | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const ratioAt = (x: number) => {
    const r = ref.current!.getBoundingClientRect()
    return Math.min(1, Math.max(0, (x - r.left) / r.width))
  }
  const shown = drag ?? (dur ? pos / dur : 0)
  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (!dur) return
    e.currentTarget.setPointerCapture(e.pointerId)
    setDrag(ratioAt(e.clientX))
  }
  const move = (e: PointerEvent<HTMLDivElement>) => {
    if (!dur) return
    const r = ratioAt(e.clientX)
    if (drag != null) setDrag(r)
    setHover(r)
  }
  const up = (e: PointerEvent<HTMLDivElement>) => {
    if (drag == null) return
    const r = ratioAt(e.clientX)
    setDrag(null)
    player().seek(r * dur)
  }
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowRight') { e.preventDefault(); player().seek(pos + 5000) }
    if (e.key === 'ArrowLeft') { e.preventDefault(); player().seek(pos - 5000) }
  }
  if (variant === 'line') {
    return <div className="prog-line"><i style={{ transform: `scaleX(${shown})` }} /></div>
  }
  return (
    <div className={`prog ${variant} ${drag != null ? 'dragging' : ''}`}>
      {showTimes && <span className="prog-time tabular">{fmt(drag != null ? drag * dur : pos)}</span>}
      <div
        ref={ref}
        className="prog-track"
        role="slider"
        tabIndex={0}
        aria-label="Seek"
        aria-valuemin={0}
        aria-valuemax={Math.round(dur / 1000)}
        aria-valuenow={Math.round(pos / 1000)}
        aria-valuetext={`${fmt(pos)} of ${fmt(dur)}`}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerLeave={() => setHover(null)}
        onKeyDown={onKey}
      >
        <div className="prog-rail">
          <div className="prog-buf" style={{ transform: `scaleX(${Math.max(buffered, shown)})` }} />
          <div className="prog-fill" style={{ transform: `scaleX(${shown})` }} />
        </div>
        <div className="prog-thumb" style={{ left: `${shown * 100}%` }} />
        {hover != null && dur > 0 && (
          <div className="prog-tip tabular" style={{ left: `${(drag ?? hover) * 100}%` }}>{fmt((drag ?? hover) * dur)}</div>
        )}
      </div>
      {showTimes && <span className="prog-time tabular right">-{fmt(Math.max(0, dur - (drag != null ? drag * dur : pos)))}</span>}
    </div>
  )
}

export function VolumeSlider({ compact = false }: { compact?: boolean }) {
  const volume = usePlayer((s) => s.volume)
  const muted = usePlayer((s) => s.muted)
  const v = muted ? 0 : volume
  return (
    <div className={`vol ${compact ? 'compact' : ''}`}>
      <button className="icon-btn sm" aria-label={muted ? 'Unmute' : 'Mute'} onClick={() => player().toggleMute()}>
        <VolumeIcon v={v} />
      </button>
      <input
        className="range"
        type="range"
        min={0}
        max={100}
        value={v}
        aria-label="Volume"
        style={{ ['--fill' as string]: `${v}%` }}
        onChange={(e) => player().setVolume(Number(e.target.value))}
      />
    </div>
  )
}

function VolumeIcon({ v }: { v: number }) {
  const name = v === 0 ? 'mute' : v < 50 ? 'volumeLow' : 'volume'
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={name === 'mute' ? 'M4 9.5h3l4.5-4v13L7 14.5H4zM16 9.5l5 5M21 9.5l-5 5' : name === 'volumeLow' ? 'M4 9.5h3l4.5-4v13L7 14.5H4zM15.5 9a4 4 0 0 1 0 6' : 'M4 9.5h3l4.5-4v13L7 14.5H4zM15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11'} />
    </svg>
  )
}
