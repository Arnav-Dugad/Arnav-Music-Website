import { doc, collection, runTransaction, serverTimestamp } from 'firebase/firestore'
import { firestore } from '../lib/firebase'
import { ls } from '../lib/idb'
import { useUsage } from '../lib/usage'
import { MOOD_KEYS, type Mood } from '../lib/types'
import { settings, useSettings, type Settings } from '../state/settings'

/**
 * Two-way settings sync with the Android app through its own records
 * (users/{uid}/liveRecords/s_<field>, value = the field's kotlinx JSON).
 * Values the web can't represent (e.g. OLED) are never overwritten: a field is pushed only
 * when it was changed on the web since the last sync.
 */
type Json = string | number | boolean | string[]
interface Field { app: string; toApp: (s: Settings) => Json; fromApp: (v: unknown) => Partial<Settings> | null }

const bool = (web: keyof Settings, app = web as string): Field => ({
  app, toApp: (s) => Boolean(s[web]), fromApp: (v) => (typeof v === 'boolean' ? ({ [web]: v } as Partial<Settings>) : null),
})
const int = (web: keyof Settings, lo: number, hi: number): Field => ({
  app: web, toApp: (s) => Math.round(Number(s[web])), fromApp: (v) => (typeof v === 'number' && Number.isFinite(v) ? ({ [web]: Math.min(hi, Math.max(lo, Math.round(v))) } as Partial<Settings>) : null),
})

function argbToHex(v: number): string { return `#${((v >>> 0) & 0xffffff).toString(16).padStart(6, '0').toUpperCase()}` }
function hexToArgb(h: string): number {
  const n = parseInt(h.replace('#', '').slice(0, 6), 16)
  return Number.isFinite(n) ? ((0xff << 24) | n) | 0 : (0xff8c7cff | 0)
}

export const SETTING_FIELDS: Field[] = [
  { app: 'themeMode', toApp: (s) => (s.themeMode === 'system' ? 'SYSTEM' : s.themeMode === 'light' ? 'LIGHT' : 'DARK'),
    fromApp: (v) => (v === 'SYSTEM' ? { themeMode: 'system' } : v === 'LIGHT' ? { themeMode: 'light' } : v === 'DARK' || v === 'OLED' ? { themeMode: 'dark' } : null) },
  { app: 'accentMode', toApp: (s) => (s.accentMode === 'preset' ? 'PRESET' : 'ARTWORK'),
    fromApp: (v) => (v === 'PRESET' ? { accentMode: 'preset' } : v === 'ARTWORK' || v === 'MATERIAL_YOU' ? { accentMode: 'artwork' } : null) },
  { app: 'presetAccent', toApp: (s) => hexToArgb(s.presetAccent), fromApp: (v) => (typeof v === 'number' ? { presetAccent: argbToHex(v) } : null) },
  { app: 'glass', toApp: (s) => (s.glass ? 'SUBTLE' : 'OFF'), fromApp: (v) => (v === 'OFF' ? { glass: false } : v === 'SUBTLE' || v === 'FULL' ? { glass: true } : null) },
  { app: 'motion', toApp: (s) => (s.motion === 'full' ? 'FULL' : s.motion === 'reduced' ? 'REDUCED' : 'MINIMAL'),
    fromApp: (v) => (v === 'FULL' ? { motion: 'full' } : v === 'REDUCED' ? { motion: 'reduced' } : v === 'MINIMAL' ? { motion: 'off' } : null) },
  bool('highContrast'),
  { app: 'libraryLayout', toApp: (s) => (s.libraryLayout === 'grid' ? 'GRID' : 'LIST'), fromApp: (v) => (v === 'GRID' ? { libraryLayout: 'grid' } : v === 'LIST' || v === 'COMPACT' ? { libraryLayout: 'list' } : null) },
  bool('aiEnabled'), bool('aiPersonalization'), bool('explanations'),
  int('dailyAiLimit', 0, 500), int('youtubeDailyBudget', 100, 1_000_000),
  { app: 'selectedMoods', toApp: (s) => [...s.selectedMoods].sort(),
    fromApp: (v) => (Array.isArray(v) ? { selectedMoods: v.filter((m): m is Mood => typeof m === 'string' && (MOOD_KEYS as string[]).includes(m)) } : null) },
  { app: 'seedArtists', toApp: (s) => s.seedArtists, fromApp: (v) => (Array.isArray(v) ? { seedArtists: v.filter((x): x is string => typeof x === 'string').slice(0, 20) } : null) },
  { app: 'regionCode', toApp: (s) => s.regionCode, fromApp: (v) => (typeof v === 'string' && /^[A-Za-z]{0,2}$/.test(v) ? { regionCode: v.toUpperCase() } : null) },
  bool('preferVideos'), bool('autoReplaceUnavailable'), bool('endlessRadio'), bool('onlineLyrics'), bool('miniPlayerLyrics'), bool('movingGradient'),
  bool('ambientIdle', 'ambientEdgeGlow'),
]

const byId = new Map(SETTING_FIELDS.map((f) => [`s_${f.app}`, f]))
const encode = (v: Json) => JSON.stringify(v)
const snapshotKey = (uid: string) => `settings_snapshot_${uid}`

/** Applies a setting record from the phone unless the same field has an unsynced web edit. */
export function applyRemoteSetting(uid: string, recordId: string, value: string): void {
  if (!settings().syncSettings) return
  const f = byId.get(recordId)
  if (!f) return
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch { return }
  const snap = ls.get<Record<string, string>>(snapshotKey(uid), {})
  const current = encode(f.toApp(settings()))
  if (snap[f.app] !== undefined && snap[f.app] !== current) return // edited here; this edit wins and is pushed next
  const patch = f.fromApp(parsed)
  if (!patch) return
  useSettings.getState().update(patch)
  snap[f.app] = encode(f.toApp(settings()))
  ls.set(snapshotKey(uid), snap)
}

/** Pushes fields changed on the web since the last sync (one transaction per field). */
export async function pushSettings(uid: string, deviceId: string, journal: Record<string, { rev: number; value?: string }>): Promise<number> {
  if (!settings().syncSettings) return 0
  const snap = ls.get<Record<string, string>>(snapshotKey(uid), {})
  const db = firestore()
  let pushed = 0
  for (const f of SETTING_FIELDS) {
    const cur = encode(f.toApp(settings()))
    if (snap[f.app] === undefined) { snap[f.app] = cur; continue } // first sight: adopt, don't push
    if (snap[f.app] === cur) continue
    const id = `s_${f.app}`
    const ref = doc(collection(db, 'users', uid, 'liveRecords'), id)
    const rev = await runTransaction(db, async (tx) => {
      const ex = await tx.get(ref)
      const next = Number(ex.exists() ? ex.data().revision ?? 0 : 0) + 1
      tx.set(ref, { kind: 'setting', value: cur.slice(0, 8000), revision: next, deleted: false, deviceId, updatedAt: serverTimestamp(), schema: 1 })
      return next
    })
    useUsage.getState().bump({ firestoreReads: 1, firestoreWrites: 1 })
    journal[id] = { rev, value: cur }
    snap[f.app] = cur
    pushed++
  }
  ls.set(snapshotKey(uid), snap)
  return pushed
}

/** Fingerprint of synced fields, to request a sync when one changes. */
export const settingsFingerprint = (s: Settings) => SETTING_FIELDS.map((f) => encode(f.toApp(s))).join('|')
