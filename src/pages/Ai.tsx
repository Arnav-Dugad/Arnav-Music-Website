import { useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { AnimatePresence, motion } from 'motion/react'
import { Icon } from '../components/Icon'
import { Notice, Spinner, spring } from '../components/ui'
import { TrackList } from '../components/TrackRow'
import { EnergyChart } from '../components/Charts'
import { AI_SUGGESTIONS, moodSet, type SessionConstraints } from '../lib/intent'
import { AI_REASON_COPY, aiAvailability } from '../lib/ai'
import { REASON_COPY } from '../lib/taste'
import { longDuration } from '../lib/format'
import { MOODS } from '../lib/types'
import { createSession, recentPrompts, refine, type SessionResult, type Step } from '../services/session'
import { player } from '../state/player'
import { lib } from '../state/library'
import { toast } from '../state/ui'
import { useSettings } from '../state/settings'
import { useYoutubeReady } from '../services/status'
import { useVoice } from '../services/voice'

const STEPS: { key: Step; label: string }[] = [
  { key: 'interpret', label: 'Understanding your request' },
  { key: 'search', label: 'Finding real, playable songs' },
  { key: 'order', label: 'Shaping the energy curve' },
]

function Orb({ active }: { active: boolean }) {
  return (
    <div className={`ai-orb ${active ? 'active' : ''}`} aria-hidden>
      <i className="o1" /><i className="o2" /><i className="o3" /><i className="core" />
    </div>
  )
}

export default function AiPage() {
  const [params, setParams] = useSearchParams()
  const nav = useNavigate()
  const [text, setText] = useState(params.get('q') ?? '')
  const [step, setStep] = useState<Step | null>(null)
  const [result, setResult] = useState<SessionResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const ran = useRef<string | null>(null)
  const explanations = useSettings((s) => s.explanations)
  const aiEnabled = useSettings((s) => s.aiEnabled)
  const yt = useYoutubeReady()
  const busy = step != null && step !== 'done'
  const voice = useVoice((t) => { setText(t); submit(t) }, (t) => setText(t))

  const run = async (request: string, base?: SessionConstraints) => {
    const q = request.trim()
    if (!q || busy) return
    setError(null)
    if (!base) setResult(null)
    try {
      const r = await createSession(q, setStep, base)
      setResult(r)
      if (!r.session.tracks.length) setError(yt.ready ? 'No playable songs matched. Try naming an artist or a genre.' : 'Connect YouTube in Settings → Sources so Arnav AI can find songs.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong')
    } finally {
      setStep(null)
    }
  }

  useEffect(() => {
    const q = params.get('q')
    if (q && ran.current !== q) { ran.current = q; setText(q); void run(q) }
  }, [params]) // eslint-disable-line react-hooks/exhaustive-deps

  const submit = (q = text) => {
    if (!q.trim()) return
    ran.current = q.trim()
    setParams({ q: q.trim() }, { replace: true })
    void run(q)
  }

  const s = result?.session
  const c = s?.constraints
  const prompts = recentPrompts()
  const blocked = aiAvailability()

  return (
    <div className="page ai-page">
      <section className="ai-hero">
        <Orb active={busy} />
        <h1 className="t-hero"><span className="gradient-text">Arnav AI</span></h1>
        <p className="t-sub ai-lede">Describe a moment. Arnav AI turns it into a real session — songs that exist, ordered along an energy curve, with a reason for every pick.</p>
        <form className="ai-input glass-thick" onSubmit={(e) => { e.preventDefault(); submit() }}>
          <textarea
            value={text}
            rows={2}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() } }}
            placeholder="45 minutes of energetic coding music, mostly familiar, a few surprises"
            aria-label="Describe your session"
          />
          <div className="row ai-input-foot">
            <span className="t-caption">{!aiEnabled ? 'Cloud AI is off — on-device engine' : blocked ? AI_REASON_COPY[blocked].replace(' — answered on device.', '') : 'Gemini · free tier · with an on-device fallback'}</span>
            <div className="row" style={{ gap: 6 }}>
              {voice.supported && <button type="button" className={`icon-btn ${voice.listening ? 'on recording' : ''}`} aria-label={voice.listening ? 'Stop listening' : 'Speak your request'} onClick={voice.toggle}><Icon name="mic" size={18} /></button>}
              <motion.button whileTap={{ scale: 0.95 }} className="btn btn-primary" type="submit" disabled={busy || !text.trim()}>
                {busy ? <Spinner size={15} /> : <Icon name="sparkles" size={16} />} Create session
              </motion.button>
            </div>
          </div>
        </form>
        {!result && !busy && (
          <div className="ai-suggestions">
            {[...new Set(prompts.length ? [...prompts.slice(0, 3), ...AI_SUGGESTIONS] : AI_SUGGESTIONS)].slice(0, 8).map((sug, i) => (
              <motion.button key={sug} className="chip" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ ...spring, delay: 0.05 * i }} onClick={() => { setText(sug); submit(sug) }}>
                {i < Math.min(3, prompts.length) ? <Icon name="history" size={13} /> : <Icon name="sparkles" size={13} />} {sug}
              </motion.button>
            ))}
          </div>
        )}
      </section>

      <AnimatePresence>
        {busy && (
          <motion.div className="ai-steps glass" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={spring}>
            {STEPS.map((st, i) => {
              const idx = STEPS.findIndex((x) => x.key === step)
              const state = i < idx ? 'done' : i === idx ? 'now' : 'todo'
              return (
                <div key={st.key} className={`ai-step ${state}`}>
                  <span className="ai-step-dot">{state === 'done' ? <Icon name="check" size={12} strokeWidth={2.6} /> : state === 'now' ? <Spinner size={12} /> : null}</span>
                  {st.label}
                </div>
              )
            })}
          </motion.div>
        )}
      </AnimatePresence>

      {error && <div className="section"><Notice tone="warn" action={!yt.ready ? <button className="btn btn-sm btn-secondary" onClick={() => nav('/settings/sources')}>Connect</button> : undefined}>{error}</Notice></div>}

      <AnimatePresence mode="wait">
        {s && c && s.tracks.length > 0 && (
          <motion.section key={`${result!.request}-${c.energyTarget}-${c.durationMinutes}-${c.discoveryRatio}`} className="section ai-result" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={spring}>
            <div className="ai-card glass">
              <div className="ai-card-head">
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                    <span className={`badge ${result!.usedAi ? 'ai' : ''}`}>{result!.usedAi ? `Gemini · ${result!.model}` : 'On-device engine'}</span>
                    {!result!.usedAi && result!.unavailable && <span className="t-caption">{AI_REASON_COPY[result!.unavailable]}</span>}
                  </div>
                  <h2 className="t-large" style={{ marginTop: 10 }}>{c.title}</h2>
                  {c.explanation && <p className="t-sub" style={{ marginTop: 6 }}>{c.explanation}</p>}
                  <div className="t-caption" style={{ marginTop: 8 }}>{s.tracks.length} songs · {longDuration(s.totalMs)} · {s.discovered} new to you</div>
                </div>
                <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                  <motion.button whileTap={{ scale: 0.95 }} className="btn btn-primary btn-lg" onClick={() => player().play(s.tracks, 0, { context: `Arnav AI · ${c.title}`, shuffle: false })}><Icon name="play" size={16} /> Play</motion.button>
                  <button className="btn btn-secondary btn-lg" onClick={() => { const id = lib().createPlaylist(c.title, s.tracks, `Arnav AI: “${result!.request}”`); toast('Saved as a playlist', { label: 'Open', run: () => nav(`/playlist/${id}`) }) }}><Icon name="plus" size={16} /> Save</button>
                </div>
              </div>
              <div className="ai-chips">
                {moodSet(c).map((m) => <span key={m} className="chip mood-chip" style={{ ['--h' as string]: MOODS[m].hue }}>{MOODS[m].label}</span>)}
                {c.avoidMoods.map((m) => <span key={m} className="chip" style={{ opacity: 0.7 }}>No {m}</span>)}
                <span className="chip">{c.durationMinutes} min</span>
                <span className="chip">Energy {Math.round(c.energyTarget * 100)}% · {c.energyCurve.toLowerCase()}</span>
                <span className="chip">{Math.round(c.discoveryRatio * 100)}% new</span>
                {c.seedArtists.map((a) => <span key={a} className="chip">Like {a}</span>)}
              </div>
              <EnergyChart constraints={c} tracks={s.tracks} />
              <div className="ai-refine">
                <span className="t-caption">Refine</span>
                {([['calmer', 'Calmer'], ['energetic', 'More energy'], ['newer', 'More new music'], ['familiar', 'More familiar'], ['shorter', 'Shorter'], ['longer', 'Longer']] as const).map(([k, label]) => (
                  <button key={k} className="chip" disabled={busy} onClick={() => void run(result!.request, refine(c, k))}>{label}</button>
                ))}
              </div>
            </div>
            <div className="section" style={{ marginTop: 24 }}>
              <TrackList tracks={s.tracks} context={`Arnav AI · ${c.title}`} captions={explanations ? Object.fromEntries(s.tracks.map((t) => [t.id, REASON_COPY[s.reasons[t.id]] ?? ''])) : undefined} />
            </div>
          </motion.section>
        )}
      </AnimatePresence>
    </div>
  )
}
