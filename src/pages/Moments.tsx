import { useNavigate } from 'react-router-dom'
import { motion } from 'motion/react'
import { PageHeader, Tilt, spring } from '../components/ui'
import { MomentArt } from '../components/Mix'
import { MOMENTS, featuredMoment } from '../lib/moments'
import { MOODS } from '../lib/types'

export default function MomentsPage() {
  const nav = useNavigate()
  const featured = featuredMoment()
  return (
    <div className="page moments-page">
      <PageHeader title="Moments" subtitle="Ten immersive environments, each with its own motion, light and type — and music to match." />
      <div className="moments-grid section" style={{ marginTop: 26 }}>
        {[featured, ...MOMENTS.filter((m) => m.id !== featured.id)].map((m, i) => (
          <motion.div key={m.id} className={`moment-tile ${i === 0 ? 'featured' : ''}`} initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ ...spring, delay: i * 0.04 }}>
            <Tilt max={4}>
              <button className="moment-btn" onClick={() => nav(`/moment/${m.id}`)} aria-label={m.title}>
                <MomentArt m={m} large />
                <span className="moment-meta">
                  {i === 0 && <span className="badge">Right now</span>}
                  <span className="t-caption" style={{ color: 'rgba(255,255,255,.75)' }}>{m.moods.map((x) => MOODS[x].label).join(' · ')}</span>
                </span>
              </button>
            </Tilt>
          </motion.div>
        ))}
      </div>
    </div>
  )
}
