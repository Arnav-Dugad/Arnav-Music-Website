/**
 * Several open tabs of the app work as one:
 * - one tab at a time (the "leader", chosen with a Web Lock) runs cloud sync; when it closes,
 *   another takes over;
 * - a tab that saves your library tells the others, which reload it, so one tab never
 *   overwrites what another just saved.
 */
const channel: BroadcastChannel | null = typeof BroadcastChannel === 'function' ? new BroadcastChannel('arnav-tabs') : null
const tabId = Math.random().toString(36).slice(2)
type Kind = 'library'
const handlers = new Map<Kind, Set<() => void>>()

channel?.addEventListener('message', (e) => {
  const m = e.data as { kind?: Kind; from?: string }
  if (!m?.kind || m.from === tabId) return
  handlers.get(m.kind)?.forEach((fn) => fn())
})

/** Tells the other tabs something changed on disk. */
export function announce(kind: Kind) { channel?.postMessage({ kind, from: tabId }) }
export function onAnnounce(kind: Kind, fn: () => void) {
  const set = handlers.get(kind) ?? new Set()
  set.add(fn)
  handlers.set(kind, set)
  return () => { set.delete(fn) }
}

/** Runs [fn] once this tab is the leader (at once when Web Locks aren't available). */
export function whenLeader(fn: () => void) {
  const locks = (navigator as Navigator & { locks?: LockManager }).locks
  if (!locks?.request) { fn(); return }
  // The lock is held for the life of the tab: the promise never settles.
  void locks.request('arnav-sync-leader', () => { fn(); return new Promise<void>(() => undefined) }).catch(() => fn())
}
