import { useMemo } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { motion } from 'motion/react'
import { Icon } from '../components/Icon'
import { MomentCanvas } from '../components/MomentCanvas'
import { TrackList } from '../components/TrackRow'
import { Notice, SkeletonRows, spring } from '../components/ui'
import { useAsync } from '../hooks'
import { momentById } from '../lib/moments'
import { cachedSearch, search, ytQuotaState } from '../lib/youtube'
import { isSingle } from '../lib/classify'
import { rank, diversify } from '../lib/taste'
import { MOODS, MusicError, type Track } from '../lib/types'
import { allows, likedIds } from '../state/library'
import { player, usePlayer } from '../state/player'
import { profile } from '../services/recs'
import { verified } from '../services/catalog'
import { tuner } from '../lib/tuner'

async function momentTracks(seeds: string[], energy: number): Promise<Track[]> {
  const pool: Track[] = []
  const budget = ytQuotaState() === 'NORMAL' ? 2 : ytQuotaState() === 'CONSERVE' ? 1 : 0
  let remote = 0
  let lastErr: unknown = null
  for (const q of seeds) {
    const c = await cachedSearch(q, 'SONGS')
    if (c) { pool.push(...c.tracks); continue }
    if (remote >= budget) continue
    remote++
    try { pool.push(...(await search(q, 'SONGS')).tracks) } catch (e) { lastErr = e }
  }
  if (!pool.length && lastErr) throw lastErr
  const ranked = rank(verified(pool).filter((t) => isSingle(t) && allows(t)), profile(), { tune: tuner.multipliers(), liked: likedIds(), targetEnergy: energy, discovery: 0.4 })
  const picked = diversify(ranked, 2).slice(0, 40)
  tuner.offer(picked)
  return picked.map((s) => s.track)
}

export default function MomentPage() {
  const { id = '' } = useParams()
  const nav = useNavigate()
  const m = momentById(id)
  const data = useAsync(() => (m ? momentTracks(m.seedQueries, m.aesthetic.energy) : Promise.resolve([])), [id])
  const ctx = useMemo(() => (m ? `Moment · ${m.title}` : ''), [m])
  const playingHere = usePlayer((s) => s.context === ctx && s.isPlaying)
  if (!m) return <div className="page"><div className="empty"><div className="t-title">Moment not found</div></div></div>
  const tracks = data.data ?? []
  return (
    <div className="moment-page" style={{ ['--m3' as string]: m.palette[2] }}>
      <div className="moment-stage">
        <MomentCanvas m={m} />
        <button className="icon-btn moment-back" aria-label="Back" onClick={() => nav(-1)}><Icon name="chevronLeft" size={22} /></button>
        <motion.div className="moment-copy" initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} transition={{ ...spring, delay: 0.1 }}>
          <div className="t-eyebrow" style={{ color: 'rgba(255,255,255,.7)' }}>{m.moods.map((x) => MOODS[x].label).join(' · ')}</div>
          <h1 className={`moment-title type-${m.type}`}>{m.title}</h1>
          <p className="moment-sub">{m.subtitle}</p>
          <div className="row" style={{ gap: 10, marginTop: 22, flexWrap: 'wrap' }}>
            <motion.button whileTap={{ scale: 0.95 }} className="btn btn-lg moment-play" disabled={!tracks.length} onClick={() => (playingHere ? player().toggle() : player().play(tracks, 0, { context: ctx, shuffle: false }))}>
              <Icon name={playingHere ? 'pause' : 'play'} size={16} /> {playingHere ? 'Pause' : 'Enter the moment'}
            </motion.button>
            <button className="btn btn-lg moment-ghost" onClick={() => nav(`/ai?q=${encodeURIComponent(`${m.title.toLowerCase()} — ${m.subtitle.toLowerCase()}`)}`)}><Icon name="sparkles" size={16} /> Shape with Arnav AI</button>
          </div>
        </motion.div>
      </div>
      <div className="page moment-list">
        {data.loading && !tracks.length ? <SkeletonRows n={10} /> : data.error && !tracks.length ? (
          <Notice tone="warn">{data.error instanceof MusicError ? data.error.message : 'Songs couldn’t load for this moment.'}</Notice>
        ) : <TrackList tracks={tracks} context={ctx} />}
      </div>
    </div>
  )
}
