import { Reorder, useDragControls, AnimatePresence, motion } from 'motion/react'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Icon } from './Icon'
import { Artwork, Eq, Segmented } from './ui'
import { openTrackMenu } from './TrackRow'
import { usePlayer, player, useProgress, type QueueItem } from '../state/player'
import { lib } from '../state/library'
import { duration, longDuration } from '../lib/format'
import { artworkFor } from '../lib/classify'
import { toast } from '../state/ui'
import { useLiveHistory } from '../hooks'
import { QueueChat } from './QueueChat'

function Row({ item, onRemove, eta }: { item: QueueItem; onRemove: () => void; eta?: string }) {
  const controls = useDragControls()
  const t = item.track
  return (
    <Reorder.Item
      value={item}
      dragListener={false}
      dragControls={controls}
      className="q-row"
      whileDrag={{ scale: 1.03, boxShadow: '0 18px 50px rgba(0,0,0,.45)', zIndex: 5, background: 'var(--surface-raised)' }}
      transition={{ type: 'spring', stiffness: 500, damping: 40 }}
      layout="position"
      onContextMenu={(e) => openTrackMenu(e, t, { queueKey: item.key })}
    >
      <button className="q-main" onClick={() => { const i = player().queue.findIndex((q) => q.key === item.key); player().jumpTo(i) }}>
        <Artwork src={artworkFor(t, 'sm')} seed={t.artist} className="q-art" />
        <span className="grow" style={{ minWidth: 0 }}>
          <span className="q-title ellipsis">{t.title}</span>
          <span className="q-sub ellipsis">{t.artist}{eta ? <span className="subtle"> · {eta}</span> : null}</span>
        </span>
      </button>
      <span className="q-dur tabular">{duration(t.durationMs)}</span>
      <button className="icon-btn sm q-x" aria-label={`Remove ${t.title}`} onClick={onRemove}><Icon name="minus" size={16} /></button>
      <span className="q-handle" onPointerDown={(e) => controls.start(e)} aria-label="Drag to reorder" role="button" tabIndex={-1}><Icon name="drag" size={16} /></span>
    </Reorder.Item>
  )
}

export function QueuePanel() {
  const queue = usePlayer((s) => s.queue)
  const index = usePlayer((s) => s.index)
  const playing = usePlayer((s) => s.isPlaying)
  const context = usePlayer((s) => s.context)
  const shuffle = usePlayer((s) => s.shuffle)
  const repeat = usePlayer((s) => s.repeat)
  const radioLoading = usePlayer((s) => s.radioLoading)
  const [tab, setTab] = useState<'next' | 'history'>('next')
  const nav = useNavigate()
  const current = queue[index]
  const upcoming = useMemo(() => queue.slice(index + 1), [queue, index])
  const pos = useProgress((s) => Math.floor(s.position / 30_000))
  const etas = useMemo(() => {
    const now = Date.now()
    let t = now + Math.max(0, (current?.track.durationMs ?? 0) - pos * 30_000)
    return upcoming.map((q) => {
      const at = t
      t += q.track.durationMs ?? 210_000
      return new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    })
  }, [upcoming, current, pos])
  const totalMs = upcoming.reduce((a, q) => a + (q.track.durationMs ?? 0), 0)
  const history = useLiveHistory(30)

  return (
    <div className="queue">
      <div className="q-head">
        <Segmented id="qtab" size="sm" value={tab} onChange={setTab} options={[{ value: 'next', label: 'Up Next' }, { value: 'history', label: 'History' }]} />
        <span className="grow" />
        {tab === 'next' && upcoming.length > 0 && (
          <>
            <button className="icon-btn sm" aria-label="Save queue as playlist" title="Save queue as playlist" onClick={() => {
              const id = lib().createPlaylist(`Queue · ${new Date().toLocaleDateString([], { month: 'short', day: 'numeric' })}`, queue.slice(index).map((q) => q.track))
              toast('Saved as a playlist', { label: 'Open', run: () => { player().setExpanded(false); nav(`/playlist/${id}`) } })
            }}><Icon name="plus" size={17} /></button>
            <button className="btn btn-ghost btn-sm" onClick={() => player().clearUpcoming()}>Clear</button>
          </>
        )}
      </div>
      {tab === 'next' && <QueueChat />}
      {tab === 'next' ? (
        <div className="q-scroll">
          {current && (
            <div className="q-now">
              <div className="t-eyebrow">Now playing{context ? ` · ${context}` : ''}</div>
              <div className="q-row current">
                <div className="q-main">
                  <div style={{ position: 'relative' }}>
                    <Artwork src={artworkFor(current.track, 'sm')} seed={current.track.artist} className="q-art" />
                    <span className="q-eq"><Eq playing={playing} /></span>
                  </div>
                  <span className="grow" style={{ minWidth: 0 }}>
                    <span className="q-title ellipsis">{current.track.title}</span>
                    <span className="q-sub ellipsis">{current.track.artist}</span>
                  </span>
                </div>
              </div>
            </div>
          )}
          <div className="q-section">
            <div className="t-eyebrow">
              Up next {upcoming.length > 0 && <span className="subtle">· {upcoming.length} songs · {longDuration(totalMs)}</span>}
              {shuffle && <span className="badge" style={{ marginLeft: 8 }}>Shuffle</span>}
              {repeat !== 'off' && <span className="badge" style={{ marginLeft: 6 }}>Repeat {repeat === 'one' ? 'one' : 'all'}</span>}
            </div>
            {upcoming.length === 0 ? (
              <div className="q-empty t-sub">{radioLoading ? 'Finding more songs like this…' : 'Nothing queued. Endless radio will keep the music going.'}</div>
            ) : (
              <Reorder.Group axis="y" values={upcoming} onReorder={(items) => player().setUpcoming(items)} className="q-list" as="div">
                <AnimatePresence initial={false}>
                  {upcoming.map((it, i) => <Row key={it.key} item={it} eta={i < 40 ? etas[i] : undefined} onRemove={() => player().remove(it.key)} />)}
                </AnimatePresence>
              </Reorder.Group>
            )}
            {radioLoading && upcoming.length > 0 && <div className="q-empty t-caption"><span className="spinner" style={{ width: 12, height: 12, marginRight: 8 }} />Adding songs like this</div>}
          </div>
        </div>
      ) : (
        <div className="q-scroll">
          {history.length === 0 ? <div className="q-empty t-sub">Songs you play show up here.</div> : history.map(({ track, at }, i) => (
            <motion.div key={`${track.id}-${at}`} className="q-row" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: Math.min(i, 12) * 0.015 }}>
              <button className="q-main" onClick={() => player().play([track], 0, { context: 'History' })}>
                <Artwork src={artworkFor(track, 'sm')} seed={track.artist} className="q-art" />
                <span className="grow" style={{ minWidth: 0 }}>
                  <span className="q-title ellipsis">{track.title}</span>
                  <span className="q-sub ellipsis">{track.artist} · <span className="subtle">{new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span></span>
                </span>
              </button>
            </motion.div>
          ))}
        </div>
      )}
    </div>
  )
}

