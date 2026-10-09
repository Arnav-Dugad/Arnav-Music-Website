import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AnimatePresence, motion } from 'motion/react'
import { Icon, Logo } from '../components/Icon'
import { spring, Spinner } from '../components/ui'
import { MOODS, MOOD_KEYS, type Mood } from '../lib/types'
import { useSettings } from '../state/settings'
import { useAuth, firstName } from '../state/auth'
import { useLibrary } from '../state/library'
import { useSync } from '../services/sync'
import { ui, toast } from '../state/ui'
import { isNewAccount } from '../lib/firebase'

/** Artists by scene, so a new listener finds theirs in seconds. */
const SCENES: { label: string; artists: string[] }[] = [
  { label: 'Bollywood', artists: ['Arijit Singh', 'Shreya Ghoshal', 'Pritam', 'A. R. Rahman', 'Jubin Nautiyal', 'Atif Aslam', 'Sonu Nigam', 'Neha Kakkar', 'Vishal-Shekhar', 'Sachin-Jigar'] },
  { label: 'Punjabi', artists: ['AP Dhillon', 'Diljit Dosanjh', 'Karan Aujla', 'Sidhu Moose Wala', 'Shubh', 'Guru Randhawa'] },
  { label: 'South', artists: ['Anirudh Ravichander', 'Sid Sriram', 'Devi Sri Prasad', 'Thaman S', 'Yuvan Shankar Raja'] },
  { label: 'Pop', artists: ['Taylor Swift', 'The Weeknd', 'Dua Lipa', 'Ed Sheeran', 'Billie Eilish', 'Ariana Grande', 'Harry Styles', 'Olivia Rodrigo'] },
  { label: 'Hip-hop', artists: ['Drake', 'Kendrick Lamar', 'Travis Scott', 'Post Malone', 'Divine', 'Seedhe Maut'] },
  { label: 'Latin & more', artists: ['Bad Bunny', 'Shakira', 'KAROL G', 'BTS', 'BLACKPINK', 'Coldplay', 'Imagine Dragons', 'Lana Del Rey'] },
]

type Step = 'hello' | 'welcome' | 'moods' | 'artists'

export default function Onboarding() {
  const nav = useNavigate()
  const s = useSettings()
  const user = useAuth((x) => x.user)
  const syncStatus = useSync((x) => x.status)
  const libSize = useLibrary((x) => Object.keys(x.likes).length + Object.keys(x.playlists).length + x.events.length)
  const [step, setStep] = useState<Step>('hello')
  const [moods, setMoods] = useState<Mood[]>(s.selectedMoods)
  const [artists, setArtists] = useState<string[]>(s.seedArtists)
  const [custom, setCustom] = useState('')
  const [scene, setScene] = useState(0)

  const finish = (seed = true) => {
    s.update({ ...(seed ? { selectedMoods: moods, seedArtists: artists } : {}), onboardingDone: true })
    nav('/', { replace: true })
  }

  // Signed in to an account that already exists: no setup — your library and taste come with it.
  useEffect(() => {
    if (!user) return
    if (isNewAccount()) { if (step === 'hello') setStep('moods'); return }
    setStep('welcome')
  }, [user]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (step !== 'welcome') return
    // Wait for the first sync (or a few seconds), so Home opens with your music already there.
    const done = syncStatus === 'UP_TO_DATE' || syncStatus === 'ERROR' || syncStatus === 'DISABLED'
    const t = setTimeout(() => {
      finish(false)
      toast(`Welcome back${firstName(user) ? `, ${firstName(user)}` : ''} — your library is here`)
    }, done ? 900 : 4500)
    return () => clearTimeout(t)
  }, [step, syncStatus]) // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v])
  const shown = useMemo(() => [...new Set([...artists.filter((a) => !SCENES.some((g) => g.artists.includes(a))), ...SCENES[scene].artists])], [artists, scene])
  const progress = step === 'moods' ? 1 : step === 'artists' ? 2 : 0

  return (
    <div className="onboarding-page">
      <div className="living ob-bg"><div className="blob b1" /><div className="blob b2" /><div className="blob b3" /><div className="grain" /></div>
      {progress > 0 && <div className="ob-progress" aria-hidden><motion.i animate={{ width: `${(progress / 2) * 100}%` }} transition={spring} /></div>}
      <AnimatePresence mode="wait">
        {step === 'hello' && (
          <motion.section key="hello" className="ob-step center-col" initial={{ opacity: 0, y: 30 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20, filter: 'blur(6px)' }} transition={spring}>
            <motion.div initial={{ scale: 0.6, opacity: 0, rotate: -8 }} animate={{ scale: 1, opacity: 1, rotate: 0 }} transition={{ type: 'spring', stiffness: 160, damping: 14, delay: 0.1 }}>
              <Logo size={96} glow />
            </motion.div>
            <h1 className="ob-title">Music, <span className="gradient-text">alive.</span></h1>
            <p className="ob-lede">Your music from YouTube, with lyrics that move with the song, friends who listen along, and a home that learns what you love.</p>
            <div className="ob-choices">
              <motion.button className="ob-choice primary" whileTap={{ scale: 0.97 }} onClick={() => setStep('moods')}>
                <span className="ob-choice-icon"><Icon name="sparkles" size={20} /></span>
                <span className="col" style={{ gap: 2, textAlign: 'left' }}><b>I’m new here</b><span>Pick a few favourites — takes 20 seconds</span></span>
                <Icon name="chevronRight" size={18} />
              </motion.button>
              <motion.button className="ob-choice" whileTap={{ scale: 0.97 }} onClick={() => ui().set({ authOpen: true })}>
                <span className="ob-choice-icon"><Icon name="user" size={20} /></span>
                <span className="col" style={{ gap: 2, textAlign: 'left' }}><b>I have an account</b><span>Sign in — your library, likes and history come back</span></span>
                <Icon name="chevronRight" size={18} />
              </motion.button>
            </div>
            <button className="btn btn-ghost btn-sm ob-later" onClick={() => finish(false)}>Just look around</button>
          </motion.section>
        )}

        {step === 'welcome' && (
          <motion.section key="welcome" className="ob-step center-col" initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, y: -20 }} transition={spring}>
            <motion.div className="ob-avatar" initial={{ scale: 0.4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: 'spring', stiffness: 220, damping: 16 }}>
              {user?.photoURL ? <img src={user.photoURL} alt="" referrerPolicy="no-referrer" /> : <span>{(user?.displayName || user?.email || '?')[0].toUpperCase()}</span>}
              <motion.i className="ob-avatar-ring" animate={{ rotate: 360 }} transition={{ duration: 2.4, repeat: Infinity, ease: 'linear' }} />
            </motion.div>
            <h1 className="ob-h">Welcome back{firstName(user) ? `, ${firstName(user)}` : ''}</h1>
            <p className="t-sub ob-welcome-sub">{syncStatus === 'UP_TO_DATE' ? (libSize ? 'Your library is here.' : 'You’re all set.') : <><Spinner size={13} /> Bringing your library, likes and history…</>}</p>
            <button className="btn btn-ghost btn-sm" onClick={() => finish(false)}>Go to Home</button>
          </motion.section>
        )}

        {step === 'moods' && (
          <motion.section key="moods" className="ob-step" initial={{ opacity: 0, x: 40 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -40 }} transition={spring}>
            <div className="t-eyebrow">Step 1 of 2</div>
            <h1 className="ob-h">What moves you?</h1>
            <p className="t-sub">Pick a few moods. Home starts here, then learns from everything you play.</p>
            <div className="ob-moods">
              {MOOD_KEYS.map((m, i) => (
                <motion.button key={m} className={`ob-mood ${moods.includes(m) ? 'on' : ''}`} style={{ ['--h' as string]: MOODS[m].hue }} onClick={() => setMoods(toggle(moods, m))}
                  initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} transition={{ ...spring, delay: i * 0.025 }} whileTap={{ scale: 0.94 }}>
                  {moods.includes(m) && <Icon name="check" size={14} strokeWidth={2.6} />} {MOODS[m].label}
                </motion.button>
              ))}
            </div>
            <div className="ob-actions">
              <button className="btn btn-ghost" onClick={() => setStep('hello')}>Back</button>
              <button className="btn btn-primary btn-lg" onClick={() => setStep('artists')}>{moods.length ? 'Continue' : 'Skip'}</button>
            </div>
          </motion.section>
        )}

        {step === 'artists' && (
          <motion.section key="artists" className="ob-step" initial={{ opacity: 0, x: 40 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -40 }} transition={spring}>
            <div className="t-eyebrow">Step 2 of 2</div>
            <h1 className="ob-h">Artists you love</h1>
            <p className="t-sub">{artists.length ? `${artists.length} picked — ` : ''}your Home fills with them right away.</p>
            <div className="ob-scenes" role="tablist">
              {SCENES.map((g, i) => <button key={g.label} role="tab" aria-selected={i === scene} className={`chip ${i === scene ? 'on' : ''}`} onClick={() => setScene(i)}>{g.label}</button>)}
            </div>
            <div className="ob-moods">
              <AnimatePresence initial={false} mode="popLayout">
                {shown.map((a, i) => (
                  <motion.button key={a} layout className={`ob-mood artist ${artists.includes(a) ? 'on' : ''}`} onClick={() => setArtists(toggle(artists, a))}
                    initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.9 }} transition={{ ...spring, delay: Math.min(i, 10) * 0.02 }} whileTap={{ scale: 0.94 }}>
                    {artists.includes(a) && <Icon name="check" size={14} strokeWidth={2.6} />} {a}
                  </motion.button>
                ))}
              </AnimatePresence>
            </div>
            <form className="ob-add" onSubmit={(e) => { e.preventDefault(); const v = custom.trim(); if (v && !artists.includes(v)) setArtists([...artists, v]); setCustom('') }}>
              <input className="field" value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="Someone else? Type a name" aria-label="Add an artist" />
              <button className="btn btn-secondary" type="submit" disabled={!custom.trim()}><Icon name="plus" size={15} /> Add</button>
            </form>
            <div className="ob-actions">
              <button className="btn btn-ghost" onClick={() => setStep('moods')}>Back</button>
              <button className="btn btn-primary btn-lg" onClick={() => finish()}>Start listening <Icon name="play" size={14} /></button>
            </div>
          </motion.section>
        )}
      </AnimatePresence>
      {step !== 'welcome' && <button className="ob-skip btn btn-ghost btn-sm" onClick={() => finish(step !== 'hello')}>Skip</button>}
    </div>
  )
}
