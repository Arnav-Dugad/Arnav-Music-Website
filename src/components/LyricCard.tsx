import { useEffect, useMemo, useState } from 'react'
import { Icon } from './Icon'
import { Sheet, Spinner } from './ui'
import { renderLyricCard, shareLyricCard } from '../lib/shareCard'
import { useLyrics } from '../state/lyrics'
import { currentTrack } from '../state/player'
import { toast } from '../state/ui'

const MAX = 4

/** Pick up to four lines, see the card as you go, then share or save it. */
export function LyricCardSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const lyrics = useLyrics((s) => s.lyrics)
  const lines = useMemo(() => {
    if (!lyrics) return [] as string[]
    const raw = lyrics.kind === 'synced' ? lyrics.lines.map((l) => l.text) : lyrics.lines
    return raw.map((l) => l.trim()).filter(Boolean)
  }, [lyrics])
  const [picked, setPicked] = useState<number[]>([])
  const [preview, setPreview] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (open) setPicked([]) }, [open])
  const chosen = picked.slice().sort((a, b) => a - b).map((i) => lines[i])
  // The live preview follows your picks.
  useEffect(() => {
    const t = currentTrack()
    if (!open || !t || !chosen.length) { setPreview(null); return }
    let url: string | null = null
    let alive = true
    void renderLyricCard(t, chosen).then((b) => { if (!alive) return; url = URL.createObjectURL(b); setPreview(url) }).catch(() => undefined)
    return () => { alive = false; if (url) URL.revokeObjectURL(url) }
  }, [open, picked.join(',')]) // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = (i: number) => setPicked((p) => (p.includes(i) ? p.filter((x) => x !== i) : p.length >= MAX ? p : [...p, i]))
  return (
    <Sheet open={open} onClose={onClose} title="Share lyrics" width={760} className="lyric-card-sheet">
      <div className="lyric-card-layout">
        <div className="lyric-card-lines" role="group" aria-label={`Pick up to ${MAX} lines`}>
          {lines.length === 0 && <div className="t-sub">No lyrics for this song yet.</div>}
          {lines.map((l, i) => (
            <button key={i} className={`lyric-pick ${picked.includes(i) ? 'on' : ''}`} aria-pressed={picked.includes(i)} disabled={!picked.includes(i) && picked.length >= MAX} onClick={() => toggle(i)}>{l}</button>
          ))}
        </div>
        <div className="lyric-card-side">
          <div className="lyric-card-preview">{preview ? <img src={preview} alt="Your lyric card" /> : <div className="t-caption">Pick up to {MAX} lines</div>}</div>
          <button className="btn btn-primary" disabled={!chosen.length || busy} onClick={async () => {
            const t = currentTrack()
            if (!t) return
            setBusy(true)
            try { await shareLyricCard(t, chosen); onClose() } catch { toast('The card couldn’t be made') } finally { setBusy(false) }
          }}>{busy ? <Spinner size={14} /> : <Icon name="share" size={15} />} Share card</button>
        </div>
      </div>
    </Sheet>
  )
}
