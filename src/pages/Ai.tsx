/**
 * Arnav AI — describe a moment, get a real session. Laid out like Apple Intelligence: a greeting,
 * one glowing glass composer (with quick length and discovery controls), idea cards for right now,
 * a live "thinking" timeline, then the session as a card you can play, save or keep shaping.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { AnimatePresence, motion } from 'motion/react'
import { Icon, type IconName } from '../components/Icon'
import { Notice, Spinner, spring } from '../components/ui'
import { TrackList } from '../components/TrackRow'
import { EnergyChart } from '../components/Charts'
import { MixArt } from '../components/Mix'
import { AI_SUGGESTIONS, moodSet, type SessionConstraints } from '../lib/intent'
import { AI_REASON_COPY, aiAvailability } from '../lib/ai'
import { REASON_COPY } from '../lib/taste'
import { longDuration } from '../lib/format'
import { hashHue } from '../lib/color'
import { MOODS } from '../lib/types'
import { createSession, recentPrompts, refine, type SessionResult, type Step } from '../services/session'
import { player } from '../state/player'
import { lib } from '../state/library'
import { toast } from '../state/ui'
import { useSettings } from '../state/settings'
import { firstName, useAuth } from '../state/auth'
import { useYoutubeReady } from '../services/status'
import { useVoice } from '../services/voice'
import { ytQuotaState } from '../lib/youtube'

const STEPS: { key: Step; label: string; sub: string }[] = [
  { key: 'interpret', label: 'Understanding you', sub: 'Mood, energy, length and how much new music' },
  { key: 'search', label: 'Finding real songs', sub: 'Only tracks that exist and play here' },
  { key: 'order', label: 'Shaping the flow', sub: 'Ordering along an energy curve' },
]

type Len = 0 | 20 | 45 | 90
type Mix = 'auto' | 'familiar' | 'balanced' | 'new'
const LENGTHS: { v: Len; label: string }[] = [{ v: 0, label: 'Any length' }, { v: 20, label: '20 min' }, { v: 45, label: '45 min' }, { v: 90, label: '1½ hours' }]
const MIXES: { v: Mix; label: string; text: string }[] = [
  { v: 'auto', label: 'Auto', text: '' },
  { v: 'familiar', label: 'Familiar', text: 'mostly songs I already love' },
  { v: 'balanced', label: 'Balanced', text: 'a mix of favourites and new finds' },
  { v: 'new', label: 'New to me', text: 'mostly music I haven’t heard' },
]

interface Idea { title: string; prompt: string; icon: IconName; hue: number }

/** Ideas for this time of day first, then the classics. */
function ideasNow(now = new Date()): Idea[] {
  const h = now.getHours()
  const weekend = now.getDay() === 0 || now.getDay() === 6
  const moment: Idea =
    h < 5 ? { title: 'Still up', prompt: 'Very late night, quiet and dreamy, nothing loud', icon: 'moon', hue: 250 }
      : h < 11 ? { title: weekend ? 'Slow morning' : 'Morning start', prompt: weekend ? 'Lazy weekend morning, warm acoustic and soft pop' : 'Bright morning energy to get going, upbeat but not frantic', icon: 'sun', hue: 40 }
        : h < 17 ? { title: 'Afternoon focus', prompt: 'An hour of deep focus, steady energy, no vocals that distract', icon: 'bolt', hue: 190 }
          : h < 21 ? { title: 'Evening wind-down', prompt: 'Evening wind-down, warm and mellow, slowly getting calmer', icon: 'headphones', hue: 300 }
            : { title: 'Night drive', prompt: 'Late night drive, cinematic, slowly winding down', icon: 'moon', hue: 265 }
  return [
    moment,
    { title: 'Workout peak', prompt: 'Gym session that builds up to a peak', icon: 'flame', hue: 12 },
    { title: 'Rediscover', prompt: 'Rediscover favourites I haven’t played in a while', icon: 'history', hue: 150 },
    { title: 'Something new', prompt: 'Something new — upbeat songs I’ve never heard, close to my taste', icon: 'sparkles', hue: 330 },
    { title: 'Rainy day', prompt: 'Rainy day, acoustic and calm', icon: 'cloud', hue: 210 },
    { title: 'Party starter', prompt: 'Party starter — high energy hits everyone knows', icon: 'speed', hue: 55 },
  ]
}

function greeting(name: string | null, now = new Date()) {
  const h = now.getHours()
  const part = h < 5 ? 'Up late' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'
  return name ? `${part}, ${name}` : part
}

export default function AiPage() {
  const [params, setParams] = useSearchParams()
  const nav = useNavigate()
  const [text, setText] = useState(params.get('q') ?? '')
  const [len, setLen] = useState<Len>(0)
  const [mix, setMix] = useState<Mix>('auto')
  const [follow, setFollow] = useState('')
  const [step, setStep] = useState<Step | null>(null)
  const [result, setResult] = useState<SessionResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const ran = useRef<string | null>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const explanations = useSettings((s) => s.explanations)
  const aiEnabled = useSettings((s) => s.aiEnabled)
  const user = useAuth((s) => s.user)
  const yt = useYoutubeReady()
  const busy = step != null && step !== 'done'
  const voice = useVoice((t) => { setText(t); submit(t) }, (t) => setText(t))
  const ideas = useMemo(() => ideasNow(), [])

  /** The request as typed, plus the quick controls in words the interpreter understands. */
  const withControls = (q: string) => {
    const extra = [len ? `about ${len} minutes` : '', MIXES.find((m) => m.v === mix)?.text ?? ''].filter(Boolean)
    return extra.length ? `${q.trim()} — ${extra.join(', ')}` : q.trim()
  }

  const run = async (request: string, base?: SessionConstraints) => {
    const q = request.trim()
    if (!q || busy) return
    setError(null)
    if (!base) setResult(null)
    try {
      const r = await createSession(q, setStep, base)
      setResult(r)
      if (!r.session.tracks.length) {
        setError(!yt.ready ? 'Connect YouTube in Settings → Sources so Arnav AI can find songs.'
          : ytQuotaState() === 'EXHAUSTED' ? 'Today’s YouTube search quota is used up, so Arnav AI can’t look for new songs right now. It resets at midnight Pacific — your library and saved playlists still play.'
            : 'No playable songs matched. Try naming an artist or a genre.')
      }
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
    const full = withControls(q)
    ran.current = full
    setParams({ q: full }, { replace: true })
    void run(full)
  }
  const ask = (q: string) => { setText(q); submit(q) }

  const s = result?.session
  const c = s?.constraints
  const prompts = recentPrompts()
  const blocked = aiAvailability()
  const engine = !aiEnabled ? 'On-device engine' : blocked ? AI_REASON_COPY[blocked].replace(' — answered on device.', '') : 'Gemini, with an on-device fallback'
  const stepIdx = STEPS.findIndex((x) => x.key === step)
  const hasResult = !!(s && c && s.tracks.length)

  return (
    <div className={`page ai-page ${hasResult ? 'has-result' : ''}`}>
      <div className="ai-aura" aria-hidden><i /><i /><i /></div>

      <section className="ai-hero">
        <motion.div className="ai-hello" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={spring}>
          <span className="ai-mark" aria-hidden><Icon name="sparkles" size={16} /></span>
          <span>{greeting(firstName(user))}</span>
        </motion.div>
        <motion.h1 className="ai-title" initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ ...spring, delay: 0.04 }}>
          What should we <span className="ai-shimmer">play</span>?
        </motion.h1>

        <motion.form className={`ai-composer ${busy ? 'thinking' : ''}`} onSubmit={(e) => { e.preventDefault(); submit() }}
          initial={{ opacity: 0, y: 18, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ ...spring, delay: 0.08 }}>
          <span className="ai-rim" aria-hidden />
          <div className="ai-composer-body glass-thick">
            <textarea
              ref={input}
              value={text}
              rows={2}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() } }}
              placeholder="Describe a moment — “rainy evening, Arijit but not sad, an hour”"
              aria-label="Describe your session"
            />
            <div className="ai-composer-foot">
              <div className="ai-controls" role="group" aria-label="Session options">
                <label className="ai-select">
                  <Icon name="clock" size={14} />
                  <select value={len} onChange={(e) => setLen(Number(e.target.value) as Len)} aria-label="Length">
                    {LENGTHS.map((l) => <option key={l.v} value={l.v}>{l.label}</option>)}
                  </select>
                </label>
                <label className="ai-select">
                  <Icon name="compass" size={14} />
                  <select value={mix} onChange={(e) => setMix(e.target.value as Mix)} aria-label="Familiar or new">
                    {MIXES.map((m) => <option key={m.v} value={m.v}>{m.v === 'auto' ? 'Familiar & new' : m.label}</option>)}
                  </select>
                </label>
              </div>
              <div className="row" style={{ gap: 6 }}>
                {voice.supported && <button type="button" className={`icon-btn ai-mic ${voice.listening ? 'on recording' : ''}`} aria-label={voice.listening ? 'Stop listening' : 'Speak your request'} onClick={voice.toggle}><Icon name="mic" size={18} /></button>}
                <motion.button whileTap={{ scale: 0.9 }} className="ai-send" type="submit" disabled={busy || !text.trim()} aria-label="Create session">
                  {busy ? <Spinner size={16} /> : <Icon name="chevronUp" size={20} strokeWidth={2.4} />}
                </motion.button>
              </div>
            </div>
          </div>
        </motion.form>
        <div className="ai-engine t-caption"><Icon name="info" size={12} /> {engine} · every song is real and playable</div>
      </section>

      <AnimatePresence>
        {busy && (
          <motion.ol className="ai-timeline" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={spring} aria-live="polite">
            {STEPS.map((st, i) => {
              const state = i < stepIdx ? 'done' : i === stepIdx ? 'now' : 'todo'
              return (
                <li key={st.key} className={`ai-tl ${state}`}>
                  <span className="ai-tl-dot">{state === 'done' ? <Icon name="check" size={12} strokeWidth={2.8} /> : null}</span>
                  <span className="col" style={{ gap: 2, minWidth: 0 }}>
                    <b className={state === 'now' ? 'ai-shimmer' : ''}>{st.label}</b>
                    <span className="t-caption">{st.sub}</span>
                  </span>
                </li>
              )
            })}
          </motion.ol>
        )}
      </AnimatePresence>

      {error && <div className="section"><Notice tone="warn" action={!yt.ready ? <button className="btn btn-sm btn-secondary" onClick={() => nav('/settings/sources')}>Connect</button> : undefined}>{error}</Notice></div>}

      {!hasResult && !busy && (
        <>
          <section className="section ai-ideas-wrap">
            <div className="section-head"><h2>Try one of these</h2></div>
            <div className="ai-ideas">
              {ideas.map((it, i) => (
                <motion.button key={it.title} className="ai-idea glass-card lg-press" style={{ ['--h' as string]: it.hue }} onClick={() => ask(it.prompt)}
                  initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ ...spring, delay: 0.1 + 0.04 * i }}>
                  <span className="ai-idea-icon"><Icon name={it.icon} size={18} /></span>
                  <b>{i === 0 ? <><span className="ai-now">Right now</span> {it.title}</> : it.title}</b>
                  <span className="t-caption">{it.prompt}</span>
                </motion.button>
              ))}
            </div>
          </section>
          {(prompts.length > 0 || AI_SUGGESTIONS.length > 0) && (
            <section className="section">
              <div className="section-head"><h2>{prompts.length ? 'Recent' : 'More ideas'}</h2></div>
              <div className="ai-recents">
                {(prompts.length ? prompts.slice(0, 6) : AI_SUGGESTIONS.slice(0, 6)).map((p) => (
                  <button key={p} className="ai-recent" onClick={() => ask(p)}>
                    <Icon name={prompts.length ? 'history' : 'sparkles'} size={15} />
                    <span className="ellipsis">{p}</span>
                    <Icon name="chevronRight" size={15} />
                  </button>
                ))}
              </div>
            </section>
          )}
        </>
      )}

      <AnimatePresence mode="wait">
        {hasResult && s && c && (
          <motion.section key={`${result!.request}-${c.energyTarget}-${c.durationMinutes}-${c.discoveryRatio}`} className="section ai-result" initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={spring}>
            <div className="ai-session glass-card">
              <div className="ai-session-art"><MixArt title={c.title} eyebrow="Arnav AI" hue={hashHue(c.title)} tracks={s.tracks} /></div>
              <div className="ai-session-body">
                <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                  <span className={`badge ${result!.usedAi ? 'ai' : ''}`}>{result!.usedAi ? `Gemini · ${result!.model}` : 'On-device engine'}</span>
                  {!result!.usedAi && result!.unavailable && <span className="t-caption">{AI_REASON_COPY[result!.unavailable]}</span>}
                </div>
                <h2 className="ai-session-title">{c.title}</h2>
                {c.explanation && <p className="t-sub">{c.explanation}</p>}
                <div className="ai-stats">
                  <span><b>{s.tracks.length}</b> songs</span>
                  <span><b>{longDuration(s.totalMs)}</b></span>
                  <span><b>{s.discovered}</b> new to you</span>
                  <span><b>{Math.round(c.energyTarget * 100)}%</b> energy · {c.energyCurve.toLowerCase()}</span>
                </div>
                <div className="ai-chips">
                  {moodSet(c).map((m) => <span key={m} className="chip mood-chip" style={{ ['--h' as string]: MOODS[m].hue }}>{MOODS[m].label}</span>)}
                  {c.avoidMoods.map((m) => <span key={m} className="chip" style={{ opacity: 0.7 }}>No {m}</span>)}
                  {c.seedArtists.map((a) => <span key={a} className="chip">Like {a}</span>)}
                </div>
                <div className="row ai-actions" style={{ gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
                  <motion.button whileTap={{ scale: 0.95 }} className="btn btn-primary btn-lg" onClick={() => player().play(s.tracks, 0, { context: `Arnav AI · ${c.title}`, shuffle: false })}><Icon name="play" size={16} /> Play</motion.button>
                  <button className="btn btn-secondary btn-lg" onClick={() => player().play(s.tracks, 0, { context: `Arnav AI · ${c.title}`, shuffle: true })}><Icon name="shuffle" size={16} /> Shuffle</button>
                  <button className="btn btn-secondary btn-lg" onClick={() => { const id = lib().createPlaylist(c.title, s.tracks, `Arnav AI: “${result!.request}”`); toast('Saved as a playlist', { label: 'Open', run: () => nav(`/playlist/${id}`) }) }}><Icon name="plus" size={16} /> Save</button>
                  <button className="icon-btn" aria-label="Start over" title="Start over" onClick={() => { setResult(null); setText(''); setParams({}, { replace: true }); input.current?.focus() }}><Icon name="close" size={18} /></button>
                </div>
              </div>
            </div>

            <div className="ai-shape glass-card">
              <div className="ai-shape-head">
                <span className="t-eyebrow">Energy flow</span>
                <div className="ai-refine" role="group" aria-label="Refine">
                  {([['calmer', 'Calmer'], ['energetic', 'More energy'], ['newer', 'More new'], ['familiar', 'More familiar'], ['shorter', 'Shorter'], ['longer', 'Longer']] as const).map(([k, label]) => (
                    <button key={k} className="chip" disabled={busy} onClick={() => void run(result!.request, refine(c, k))}>{label}</button>
                  ))}
                </div>
              </div>
              <EnergyChart constraints={c} tracks={s.tracks} />
              <form className="ai-follow" onSubmit={(e) => { e.preventDefault(); if (!follow.trim()) return; const q = `${result!.request}. Also: ${follow.trim()}`; setFollow(''); setText(q); ran.current = q; setParams({ q }, { replace: true }); void run(q) }}>
                <Icon name="sparkles" size={15} />
                <input value={follow} onChange={(e) => setFollow(e.target.value)} placeholder="Ask for a change — “add some Punjabi”, “end on something calm”" aria-label="Ask for a change" />
                <button className="btn btn-secondary btn-sm" disabled={busy || !follow.trim()}>Update</button>
              </form>
            </div>

            <div className="section" style={{ marginTop: 22 }}>
              <TrackList tracks={s.tracks} context={`Arnav AI · ${c.title}`} captions={explanations ? Object.fromEntries(s.tracks.map((t) => [t.id, REASON_COPY[s.reasons[t.id]] ?? ''])) : undefined} />
            </div>
          </motion.section>
        )}
      </AnimatePresence>
    </div>
  )
}
