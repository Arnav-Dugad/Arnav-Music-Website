import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AnimatePresence, motion } from 'motion/react'
import { Icon, Logo } from '../components/Icon'
import { spring } from '../components/ui'
import { MOODS, MOOD_KEYS, type Mood } from '../lib/types'
import { useSettings } from '../state/settings'
import { useAuth } from '../state/auth'
import { ui } from '../state/ui'

const ARTIST_IDEAS = ['Arijit Singh', 'Taylor Swift', 'The Weeknd', 'A. R. Rahman', 'Dua Lipa', 'Coldplay', 'AP Dhillon', 'Billie Eilish', 'Drake', 'Anirudh Ravichander', 'BTS', 'Ed Sheeran', 'Pritam', 'Kendrick Lamar', 'Lana Del Rey', 'Diljit Dosanjh']

export default function Onboarding() {
  const nav = useNavigate()
  const s = useSettings()
  const user = useAuth((x) => x.user)
  const [step, setStep] = useState(0)
  const [moods, setMoods] = useState<Mood[]>(s.selectedMoods)
  const [artists, setArtists] = useState<string[]>(s.seedArtists)
  const [custom, setCustom] = useState('')
  const finish = () => {
    s.update({ selectedMoods: moods, seedArtists: artists, onboardingDone: true })
    nav('/', { replace: true })
  }
  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v])

  return (
    <div className="onboarding-page">
      <div className="living ob-bg"><div className="blob b1" /><div className="blob b2" /><div className="blob b3" /><div className="grain" /></div>
      <div className="ob-dots">{[0, 1, 2].map((i) => <span key={i} className={i === step ? 'on' : ''} />)}</div>
      <AnimatePresence mode="wait">
        {step === 0 && (
          <motion.section key="s0" className="ob-step center-col" initial={{ opacity: 0, y: 30 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20, filter: 'blur(6px)' }} transition={spring}>
            <motion.div initial={{ scale: 0.6, opacity: 0, rotate: -8 }} animate={{ scale: 1, opacity: 1, rotate: 0 }} transition={{ type: 'spring', stiffness: 160, damping: 14, delay: 0.1 }}>
              <Logo size={104} glow />
            </motion.div>
            <h1 className="ob-title">Music, <span className="gradient-text">alive.</span></h1>
            <p className="ob-lede">Lyrics that move with the song. Sessions shaped by Arnav AI. Moments to sink into. Your Taste DNA — all in your browser, in sync with your phone.</p>
            <div className="col" style={{ gap: 10, width: 'min(340px, 100%)', marginTop: 10 }}>
              {user ? (
                <div className="ob-signed"><Icon name="check" size={16} /> Signed in as {user.email}</div>
              ) : (
                <button className="btn btn-secondary btn-lg" onClick={() => ui().set({ authOpen: true })}><Icon name="user" size={17} /> Sign in to sync with your phone</button>
              )}
              <button className="btn btn-primary btn-lg" onClick={() => setStep(1)}>Get started <Icon name="chevronRight" size={17} /></button>
            </div>
          </motion.section>
        )}
        {step === 1 && (
          <motion.section key="s1" className="ob-step" initial={{ opacity: 0, x: 40 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -40 }} transition={spring}>
            <div className="t-eyebrow">Step 1 of 2</div>
            <h1 className="ob-h">What moves you?</h1>
            <p className="t-sub">Pick a few moods. Home and Arnav AI start here, then learn from what you play.</p>
            <div className="ob-moods">
              {MOOD_KEYS.map((m, i) => (
                <motion.button key={m} className={`ob-mood ${moods.includes(m) ? 'on' : ''}`} style={{ ['--h' as string]: MOODS[m].hue }} onClick={() => setMoods(toggle(moods, m))}
                  initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} transition={{ ...spring, delay: i * 0.025 }} whileTap={{ scale: 0.94 }}>
                  {moods.includes(m) && <Icon name="check" size={14} strokeWidth={2.6} />} {MOODS[m].label}
                </motion.button>
              ))}
            </div>
            <div className="ob-actions">
              <button className="btn btn-ghost" onClick={() => setStep(0)}>Back</button>
              <button className="btn btn-primary btn-lg" onClick={() => setStep(2)}>Continue</button>
            </div>
          </motion.section>
        )}
        {step === 2 && (
          <motion.section key="s2" className="ob-step" initial={{ opacity: 0, x: 40 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -40 }} transition={spring}>
            <div className="t-eyebrow">Step 2 of 2</div>
            <h1 className="ob-h">A few artists you love</h1>
            <p className="t-sub">Optional — they seed Arnav AI until your listening speaks for itself.</p>
            <form className="row" style={{ marginTop: 18, maxWidth: 520 }} onSubmit={(e) => { e.preventDefault(); const v = custom.trim(); if (v && !artists.includes(v)) setArtists([...artists, v]); setCustom('') }}>
              <input className="field" value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="Add an artist" />
              <button className="btn btn-secondary" type="submit" disabled={!custom.trim()}><Icon name="plus" size={15} /> Add</button>
            </form>
            <div className="ob-moods" style={{ marginTop: 16 }}>
              {[...new Set([...artists, ...ARTIST_IDEAS])].map((a) => (
                <button key={a} className={`ob-mood artist ${artists.includes(a) ? 'on' : ''}`} onClick={() => setArtists(toggle(artists, a))}>
                  {artists.includes(a) && <Icon name="check" size={14} strokeWidth={2.6} />} {a}
                </button>
              ))}
            </div>
            <div className="ob-actions">
              <button className="btn btn-ghost" onClick={() => setStep(1)}>Back</button>
              <button className="btn btn-primary btn-lg" onClick={finish}>Start listening <Icon name="play" size={14} /></button>
            </div>
          </motion.section>
        )}
      </AnimatePresence>
      <button className="ob-skip btn btn-ghost btn-sm" onClick={finish}>Skip</button>
    </div>
  )
}
