import { player, usePlayer, type QueueItem } from '../state/player'
import { forYouNow, freshFinds } from './recs'
import { toast } from '../state/ui'

/**
 * Smart shuffle: while it's on, a recommended song (marked with a sparkle in the queue) slips in
 * after every few of yours. Turning it off takes them out again; your own songs never move.
 */
const EVERY = 3

export function smartShuffleOn(): boolean { return usePlayer.getState().smartShuffle }

export function setSmartShuffle(on: boolean) {
  const s = usePlayer.getState()
  if (!on) {
    player().patch({ smartShuffle: false })
    player().setUpcoming(s.queue.slice(s.index + 1).filter((q) => q.source !== 'smart'))
    return
  }
  const upcoming = s.queue.slice(s.index + 1).filter((q) => q.source !== 'smart')
  const have = new Set(s.queue.map((q) => q.track.id))
  const recs = [...forYouNow(24), ...freshFinds(12)].map((r) => r.track).filter((t) => !have.has(t.id))
  if (!recs.length) { toast('Smart shuffle needs a little more listening first'); return }
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
  void upcoming
  player().setUpcoming(out)
  player().patch({ smartShuffle: true })
}

/** The shuffle button: off → shuffle → smart shuffle → off. */
export function cycleShuffle() {
  const s = usePlayer.getState()
  if (!s.shuffle) { player().toggleShuffle(); toast('Shuffle on'); return }
  if (!s.smartShuffle) { setSmartShuffle(true); if (usePlayer.getState().smartShuffle) toast('Smart shuffle — a few recommendations mixed in'); return }
  setSmartShuffle(false)
  player().toggleShuffle()
  toast('Shuffle off')
}
