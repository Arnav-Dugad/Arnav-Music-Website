import { player, usePlayer } from '../state/player'
import { toast } from '../state/ui'

/**
 * Undo skip: skip a song you'd been listening to for a while (20 s or more) and a toast offers to
 * take you back — same song, same moment. Quick skips through songs you don't want stay quiet.
 */
const MIN_LISTENED_MS = 20_000

let started = false
export function startSkipUndo() {
  if (started) return
  started = true
  let handled: unknown = null
  usePlayer.subscribe((s, p) => {
    const skip = s.lastSkip
    if (!skip || skip === handled || skip.posMs < MIN_LISTENED_MS || Date.now() - skip.at > 2000) return
    // Once the skip has actually moved on from that song (not "next" at the end of the queue).
    if (s.queue[s.index]?.key === skip.key || s.index === p.index) return
    handled = skip
    toast(`Skipped “${skip.title}”`, {
      label: 'Undo',
      run: () => {
        const q = usePlayer.getState().queue
        const i = q.findIndex((x) => x.key === skip.key)
        if (i < 0) return
        player().jumpTo(i, skip.posMs)
      },
    })
  })
}
