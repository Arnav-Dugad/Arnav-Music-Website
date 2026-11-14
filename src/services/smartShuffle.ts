import { player, usePlayer, type QueueItem } from '../state/player'
import { forYouNow, freshFinds } from './recs'
import { toast } from '../state/ui'

/**
 * Smart shuffle: while it's on, a recommended song (marked with a sparkle in the queue) slips in
 * after every few of yours. Turning it off takes them out again; your own songs never move.
 */
const EVERY = 3

export function smartShuffleOn(): boolean { return usePlayer.getState().smartShuffle }

/** Returns whether Smart shuffle is on afterwards (it needs some listening to recommend from). */
export function setSmartShuffle(on: boolean, quiet = false): boolean {
  const s = usePlayer.getState()
  if (!on) {
    player().patch({ smartShuffle: false })
    player().setUpcoming(s.queue.slice(s.index + 1).filter((q) => q.source !== 'smart'))
    return false
  }
  const have = new Set(s.queue.map((q) => q.track.id))
  const recs = [...forYouNow(24), ...freshFinds(12)].map((r) => r.track).filter((t) => !have.has(t.id))
  if (!recs.length) { if (!quiet) toast('Smart shuffle needs a little more listening first'); return false }
  if (!s.shuffle) player().toggleShuffle()
  const fresh = usePlayer.getState()
  const mine = fresh.queue.slice(fresh.index + 1).filter((q) => q.source !== 'smart')
  const out: QueueItem[] = []
  let r = 0
  mine.forEach((q, i) => {
    out.push(q)
    if ((i + 1) % EVERY === 0 && r < recs.length) out.push(player().makeItem(recs[r++], 'smart'))
  })
  // A short queue still gets a couple at the end.
  while (out.filter((q) => q.source === 'smart').length < 2 && r < recs.length) out.push(player().makeItem(recs[r++], 'smart'))
  player().setUpcoming(out)
  player().patch({ smartShuffle: true })
  return true
}

/** The shuffle button: off → shuffle → smart shuffle → off. */
export function cycleShuffle() {
  const s = usePlayer.getState()
  if (!s.shuffle) { player().toggleShuffle(); toast('Shuffle on'); return }
  if (!s.smartShuffle) {
    if (setSmartShuffle(true, true)) { toast('Smart shuffle — a few recommendations mixed in'); return }
    // Nothing to recommend yet: skip that step rather than get stuck on Shuffle.
    player().toggleShuffle()
    toast('Shuffle off · Smart shuffle unlocks after a little more listening')
    return
  }
  setSmartShuffle(false)
  player().toggleShuffle()
  toast('Shuffle off')
}
