import { useEffect, useState } from 'react'
import { Icon } from './Icon'
import { Spinner } from './ui'
import { player, usePlayer } from '../state/player'
import { hasChorus, skipToChorus, useSections } from '../state/sections'
import { SECTION_LABEL } from '../lib/sections'
import { aiAvailability } from '../lib/ai'
import { BINS, loadReplay, replayInsight, type ReplayMap } from '../lib/replayMap'
import { duration as fmt } from '../lib/format'
import type { Track } from '../lib/types'

/** The song's sections as a thin strip above the progress bar; tap one to jump there. */
export function SectionStrip() {
  const { sections, trackId } = useSections()
  const d = usePlayer((s) => s.duration)
  const current = usePlayer((s) => s.queue[s.index]?.track.id)
  if (!sections.length || !d || trackId !== current) return null
  return (
    <div className="sec-strip" role="group" aria-label="Song sections">
      {/* Sections are clamped to this upload's length (lyrics can be timed to a longer release). */}
      {sections.filter((s) => s.start < d - 500).map((s, i) => (
        <button key={i} className={`sec ${s.kind}`} style={{ left: `${(s.start / d) * 100}%`, width: `${Math.max(0.6, ((Math.min(s.end, d) - s.start) / d) * 100)}%` }}
          onClick={() => player().seek(Math.max(0, s.start - 200))} aria-label={`${SECTION_LABEL[s.kind]} at ${fmt(s.start)}`} title={`${SECTION_LABEL[s.kind]} · ${fmt(s.start)}`} />
      ))}
    </div>
  )
}

/** "Skip to chorus" — or "Find the chorus" with Arnav AI when it isn't known yet. */
export function ChorusButton({ compact = false }: { compact?: boolean }) {
  const { sections, busy, detectWithAi } = useSections()
  const known = hasChorus(sections)
  if (!known && aiAvailability()) return null
  return (
    <button className={`icon-btn ${compact ? 'sm' : ''} chorus-btn`} disabled={busy} title={known ? 'Skip to the chorus (C)' : 'Find the chorus with Arnav AI'} aria-label={known ? 'Skip to the chorus' : 'Find the chorus with Arnav AI'}
      onClick={() => (known ? skipToChorus() : void detectWithAi())}>
      {busy ? <Spinner size={15} /> : <Icon name={known ? 'bolt' : 'sparkles'} size={compact ? 17 : 19} />}
    </button>
  )
}

/** Where you skip, replay and linger in this song. */
export function ReplayCard({ track }: { track: Track }) {
  const [map, setMap] = useState<ReplayMap | null>(null)
  useEffect(() => { void loadReplay(track.id).then((m) => setMap({ ...m })) }, [track.id])
  const d = track.durationMs ?? 0
  if (!map || !d || map.plays < 1 || map.heard.every((x) => x === 0)) return null
  const ins = replayInsight(map, d)
  const max = Math.max(1, ...map.heard)
  const maxSkip = Math.max(1, ...map.skips)
  const lines = [
    ins.favorite != null ? `You linger most around ${fmt(ins.favorite)}.` : null,
    ins.replayFrom != null && ins.replayTo != null ? `You rewind to ${fmt(ins.replayFrom)} to hear ${fmt(ins.replayFrom)}–${fmt(ins.replayTo)} again (${ins.replayCount}×).` : null,
    ins.skipAt != null ? `You usually skip at ${fmt(ins.skipAt)} (${ins.skipCount}×).` : null,
  ].filter(Boolean)
  return (
    <section className="section">
      <h2 className="t-section">Your replay map</h2>
      <div className="replay glass">
        <div className="replay-bars" role="img" aria-label="How much of each part of the song you've heard">
          {map.heard.map((h, i) => (
            <span key={i} className="replay-bar" style={{ ['--h' as string]: Math.max(0.05, h / max) }}>
              {map.skips[i] > 0 && <i className="replay-skip" style={{ opacity: 0.35 + 0.65 * (map.skips[i] / maxSkip) }} title={`${map.skips[i]} skips here`} />}
            </span>
          ))}
          <svg className="replay-arcs" viewBox={`0 0 ${BINS} 10`} preserveAspectRatio="none" aria-hidden>
            {map.rewinds.slice(-12).map((r, i) => {
              const a = r.to + 0.5
              const b = r.from + 0.5
              return <path key={i} d={`M${b},10 Q${(a + b) / 2},${Math.max(0, 10 - (b - a) * 0.9)} ${a},10`} fill="none" vectorEffect="non-scaling-stroke" />
            })}
          </svg>
        </div>
        <div className="replay-axis t-caption"><span>0:00</span><span>{fmt(d)}</span></div>
        <div className="replay-legend t-caption"><span><i className="lg heard" /> Heard</span><span><i className="lg skip" /> Skipped away</span><span><i className="lg arc" /> Rewound to</span></div>
        {lines.length > 0 ? lines.map((l) => <div key={l} className="replay-line">{l}</div>) : <div className="t-caption">Play it a few more times and patterns show up here.</div>}
        <div className="t-caption">{map.plays} {map.plays === 1 ? 'play' : 'plays'} · recorded on this device</div>
      </div>
    </section>
  )
}
