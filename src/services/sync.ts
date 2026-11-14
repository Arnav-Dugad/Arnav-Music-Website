import { create } from 'zustand'
import { ls } from '../lib/idb'
import { hadSession, loadFirebase } from '../lib/firebase'
import type { Track } from '../lib/types'

/**
 * Sync status and account actions. The engine (`./syncEngine`, with the Firebase SDK) loads after
 * the first paint: at once for a browser that was signed in, when the page is idle otherwise.
 */
export type SyncStatus = 'DISABLED' | 'IDLE' | 'SYNCING' | 'OFFLINE' | 'ERROR' | 'UP_TO_DATE' | 'ACCOUNT_BLOCKED'

export interface RemoteQueue { tracks: Track[]; index: number; updatedAt: number; fromThisDevice: boolean }

interface SyncState {
  status: SyncStatus
  error: string | null
  lastSyncedAt: number
  remoteQueue: RemoteQueue | null
  pulled: { likes: number; playlists: number; history: number }
}

export const useSync = create<SyncState>()(() => ({
  status: 'IDLE',
  error: null,
  lastSyncedAt: 0,
  remoteQueue: null,
  pulled: { likes: 0, playlists: 0, history: 0 },
}))

/** Stable per-browser device id (UUID — the format Firestore rules require). */
export const deviceId: string = (() => {
  let id = ls.get<string | null>('arnav.deviceId', null)
  if (!id || !/^[0-9a-f-]{36}$/.test(id)) {
    id = crypto.randomUUID?.() ?? '00000000-0000-4000-8000-000000000000'.replace(/0/g, () => Math.floor(Math.random() * 16).toString(16))
    ls.set('arnav.deviceId', id)
  }
  return id
})()

/** The app and the Firestore rules allow this many songs in a synced playlist. */
export const PLAYLIST_CLOUD_MAX = 500

export interface DeviceInfo { id: string; label: string; appVersion?: string; lastSeen: number; lastTrack?: string; thisDevice: boolean }

let enginePromise: Promise<typeof import('./syncEngine')> | null = null
const engine = () => (enginePromise ??= import('./syncEngine').catch((e) => { enginePromise = null; throw e }))

let started = false
export function startSync() {
  if (started) return
  started = true
  const go = () => { void engine().then((m) => m.startSync(), () => { started = false }) }
  if (hadSession()) { go(); return }
  // Signed out (or never signed in): the SDK comes in when the page is idle, so it's ready
  // by the time someone opens the sign-in sheet.
  const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }
  if (w.requestIdleCallback) w.requestIdleCallback(go, { timeout: 5000 })
  else setTimeout(go, 2500)
}

/** Loads the sync engine (and Firebase) now: someone is about to sign in. */
export function warmSync() { void loadFirebase().catch(() => undefined); void engine().catch(() => undefined) }

export const syncNow = (): Promise<void> => engine().then((m) => m.syncNow())
export const requestSync = (delayMs?: number): void => { void engine().then((m) => m.requestSync(delayMs)) }
export const adoptAccount = (uid: string): Promise<void> => engine().then((m) => m.adoptAccount(uid))
export const deleteCloudData = (): Promise<void> => engine().then((m) => m.deleteCloudData())
export const sendQueueToPhone = (): Promise<void> => engine().then((m) => m.sendQueueToPhone())
export const listDevices = (): Promise<DeviceInfo[]> => engine().then((m) => m.listDevices())
/** Re-reads the Firebase user (providers change after linking Google; no auth event fires). */
export const refreshAuthUser = (): void => { void engine().then((m) => m.refreshAuthUser()) }
