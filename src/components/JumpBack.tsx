import { Card, Shelf } from './ui'
import { relative } from '../lib/format'
import { resume, useJumpBack } from '../services/jumpBack'
import { usePlayer } from '../state/player'
import { toast } from '../state/ui'

/** Home: carry on where you left off — each card resumes that queue at the same song and moment. */
export function JumpBackShelf() {
  const items = useJumpBack((s) => s.items)
  const current = usePlayer((s) => (s.context ? s.contextId ?? `ctx:${s.context}` : null))
  const list = items.filter((x) => x.key !== current).slice(0, 8)
  if (list.length < 2) return null
  return (
    <Shelf title="Jump back in" subtitle="Carry on right where you left off">
      {list.map((r) => (
        <Card key={r.key} title={r.label.replace(/^Arnav AI · /, '')} subtitle={`${r.label.startsWith('Arnav AI') ? 'AI session' : `Song ${r.index + 1} of ${r.ids.length}`} · ${relative(r.at)}`}
          art={r.art} seed={r.label} badge={<span className="badge jb-badge">Resume</span>}
          onOpen={() => { if (!resume(r)) toast('Those songs aren’t on this device any more') }}
          onPlay={() => { if (!resume(r)) toast('Those songs aren’t on this device any more') }} />
      ))}
    </Shelf>
  )
}
