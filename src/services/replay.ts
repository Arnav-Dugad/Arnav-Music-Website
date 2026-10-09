/**
 * Keeps Replay snapshots up to date: this browser registers what kind of device it is, and every
 * period you have history for is saved (and synced) whenever its Replay grows.
 */
import { liveEvents } from '../state/library'
import { trackRegistry } from '../state/tracks'
import { usePrefs } from '../state/prefs'
import { deviceId } from './sync'
import { deviceLabel, formFactor, snapshotAll } from '../lib/replay'

export function registerDevice() {
  const kind = formFactor()
  usePrefs.getState().setDevice(deviceId, { kind, label: deviceLabel(kind) })
}

/** Saves every period's Replay (a no-op for periods whose saved copy is already as full). */
export function snapshotReplays() {
  const events = liveEvents()
  if (!events.length) return
  const snaps = snapshotAll(events, (id) => trackRegistry.get(id), usePrefs.getState().devices, deviceId, formFactor())
  usePrefs.getState().saveReplay(snaps)
}

/** After start-up (once history has loaded and synced), then every half hour. */
export function startReplaySnapshots() {
  const run = () => { try { registerDevice(); snapshotReplays() } catch (e) { console.warn('[Arnav Music] replay snapshot', e) } }
  const idle = (fn: () => void) => (typeof window.requestIdleCallback === 'function' ? window.requestIdleCallback(fn, { timeout: 5000 }) : setTimeout(fn, 200))
  setTimeout(() => idle(run), 15_000)
  setInterval(() => idle(run), 30 * 60_000)
}
