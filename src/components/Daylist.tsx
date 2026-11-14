import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion } from 'motion/react'
import { Icon } from './Icon'
import { Artwork, spring } from './ui'
import { artworkFor } from '../lib/classify'
import { buildDaylist, type Daylist } from '../services/daylist'
import { player, usePlayer } from '../state/player'
import { useRegistryVersion } from '../hooks'
import { useAuth, firstName } from '../state/auth'

/** The Daylist as it stands now (rebuilt when the next stretch of the day starts). */
export function useDaylist(): Daylist | null {
  const v = useRegistryVersion()
  const [tick, setTick] = useState(0)
  const d = useMemo(() => buildDaylist(), [v, tick]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!d) return
    const t = setTimeout(() => setTick((x) => x + 1), Math.max(60_000, d.until - Date.now() + 1000))
    return () => clearTimeout(t)
  }, [d])
  return d
}

/** Its cover: the day's colours drifting behind four covers. */
export function DaylistArt({ d, large = false }: { d: Daylist; large?: boolean }) {
  const covers = [...new Set(d.tracks.map((t) => artworkFor(t, 'sm')))].slice(0, 4)
  return (
    <div className={`daylist-art ${large ? 'large' : ''}`} style={{ ['--h1' as string]: d.hues[0], ['--h2' as string]: d.hues[1] }}>
      <div className="daylist-mesh" aria-hidden><i /><i /><i /></div>
      <div className="daylist-covers" aria-hidden>{covers.map((c) => <Artwork key={c} src={c} letterbox={false} />)}</div>
      <div className="daylist-label"><span className="t-eyebrow">Daylist</span><b>{d.slot}</b></div>
    </div>
  )
}

const greetingFor = (h: number) => (h < 5 ? 'Up late' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : h < 21 ? 'Good evening' : 'Good night')

/** Home's opening: a greeting and today's Daylist, in the colours of this time of day. */
export function HomeHero() {
  const nav = useNavigate()
  const d = useDaylist()
  const user = useAuth((s) => s.user)
  const playingHere = usePlayer((s) => s.context === `Daylist · ${d?.title ?? ''}` && s.isPlaying)
  if (!d) return null
  const name = firstName(user)
  return (
    <motion.section className="home-hero" style={{ ['--h1' as string]: d.hues[0], ['--h2' as string]: d.hues[1] }}
      initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={spring}>
      <div className="home-hero-mesh" aria-hidden><i /><i /><i /></div>
      <div className="home-hero-copy">
        <div className="t-eyebrow home-hero-greet">{greetingFor(new Date().getHours())}{name ? `, ${name}` : ''}</div>
        <button className="home-hero-title" onClick={() => nav('/playlist/daylist')}>{d.title}</button>
        <div className="home-hero-sub">{d.subtitle} · {d.tracks.length} songs</div>
        <div className="row" style={{ gap: 10, marginTop: 18 }}>
          <button className="btn btn-primary btn-lg home-hero-play" onClick={() => player().play(d.tracks, 0, { context: `Daylist · ${d.title}` })} aria-label={`Play ${d.title}`}>
            <Icon name={playingHere ? 'pause' : 'play'} size={18} /> {playingHere ? 'Playing' : 'Play'}
          </button>
          <button className="btn btn-secondary btn-lg" onClick={() => nav('/playlist/daylist')}>Open</button>
          <button className="btn btn-ghost btn-lg" onClick={() => nav('/samples')}><Icon name="bolt" size={16} /> Samples</button>
        </div>
      </div>
      <button className="home-hero-art" onClick={() => nav('/playlist/daylist')} aria-label={`Open ${d.title}`}><DaylistArt d={d} large /></button>
    </motion.section>
  )
}
