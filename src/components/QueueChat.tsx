import { useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Icon } from './Icon'
import { Spinner } from './ui'
import { queueEdit, type QueueEdit } from '../lib/aiFeatures'
import { cachedSearch, search } from '../lib/youtube'
import { isSingle } from '../lib/classify'
import { player, usePlayer, type QueueItem } from '../state/player'
import { allows } from '../state/library'
import { verified } from '../services/catalog'
import { useVoice } from '../services/voice'
import type { Track } from '../lib/types'

async function songsFor(q: string): Promise<Track[]> {
  const r = (await cachedSearch(q, 'SONGS')) ?? (await search(q, 'SONGS').catch(() => null))
  return verified(r?.tracks ?? []).filter((t) => isSingle(t) && allows(t)).slice(0, 5)
}

/** Applies an edit to what's up next; returns how many songs were added. */
async function apply(edit: QueueEdit): Promise<number> {
  const s = player()
  const upcoming = s.queue.slice(s.index + 1)
  const window = upcoming.slice(0, 40)
  const removed = new Set(edit.remove.map((i) => window[i]?.key).filter(Boolean))
  const nextKeys = edit.playNext.map((i) => window[i]?.key).filter((k): k is string => !!k && !removed.has(k))
  let rest = upcoming.filter((q) => !removed.has(q.key) && !nextKeys.includes(q.key))
  if (edit.order === 'energy-up') rest = [...rest].sort((a, b) => (a.track.energy ?? 0.5) - (b.track.energy ?? 0.5))
  if (edit.order === 'energy-down') rest = [...rest].sort((a, b) => (b.track.energy ?? 0.5) - (a.track.energy ?? 0.5))
  if (edit.order === 'shuffle') rest = [...rest].sort(() => Math.random() - 0.5)
  const added: Track[] = []
  const have = new Set(s.queue.map((q) => q.track.id))
  for (const q of edit.addQueries) for (const t of await songsFor(q)) if (!have.has(t.id)) { have.add(t.id); added.push(t) }
  const front = nextKeys.map((k) => upcoming.find((q) => q.key === k)!).filter(Boolean)
  const addedItems: QueueItem[] = added.map((t, i) => ({ track: t, key: `${t.id}#chat${Date.now()}${i}` }))
  player().setUpcoming([...front, ...addedItems, ...rest])
  return added.length
}

/** "Ask Arnav to change the queue" — Gemini when available, on-device for common requests. */
export function QueueChat() {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [reply, setReply] = useState<{ text: string; ai: boolean } | null>(null)
  const hasQueue = usePlayer((s) => s.queue.length > 0)
  const run = async (q: string) => {
    const v = q.trim()
    if (!v || busy) return
    setBusy(true)
    try {
      const s = player()
      const edit = await queueEdit(v, s.queue[s.index]?.track ?? null, s.queue.slice(s.index + 1).map((x) => x.track))
      const n = await apply(edit)
      setReply({ text: edit.reply + (n && !/add/i.test(edit.reply) ? ` Added ${n} ${n === 1 ? 'song' : 'songs'}.` : ''), ai: edit.usedAi })
      setText('')
    } finally {
      setBusy(false)
    }
  }
  const voice = useVoice((t) => void run(t), (t) => setText(t))
  if (!hasQueue) return null
  return (
    <div className="qchat">
      <form className="qchat-box" onSubmit={(e) => { e.preventDefault(); void run(text) }}>
        <Icon name="sparkles" size={15} className="ask-icon" />
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Ask Arnav: “swap the sad ones”, “more energy”…" aria-label="Ask Arnav to change the queue" disabled={busy} />
        {voice.supported && <button type="button" className={`icon-btn sm ${voice.listening ? 'on recording' : ''}`} aria-label="Speak" onClick={voice.toggle}><Icon name="mic" size={15} /></button>}
        <button type="submit" className="icon-btn sm" aria-label="Apply" disabled={busy || !text.trim()}>{busy ? <Spinner size={13} /> : <Icon name="chevronRight" size={16} />}</button>
      </form>
      <AnimatePresence>
        {reply && (
          <motion.div className="qchat-reply" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
            <span className={`badge ${reply.ai ? 'ai' : ''}`}>{reply.ai ? 'Arnav AI' : 'On device'}</span> {reply.text}
            <button className="icon-btn sm" aria-label="Dismiss" onClick={() => setReply(null)}><Icon name="close" size={13} /></button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
