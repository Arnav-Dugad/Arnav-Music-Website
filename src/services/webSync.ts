/**
 * Web-only data that follows you between browsers, as `w_*` live records (kind "web") in the same
 * Firestore collection the app uses — the Android app skips kinds it doesn't know.
 *
 *   w_automix   per-playlist automix            w_lyrics   your lyric fixes (version, timing)
 *   w_settings  web-only settings               w_library  not-interested, blocked artists,
 *   w_tuner     recommendation tuner weights               saved YouTube playlists, recent searches
 *   w_glass     Liquid Glass style / strength per device (with undo history)
 *   w_devices   your browsers and their kind      w_replay   saved monthly / yearly Replays
 *
 * Each family is last-write-wins by edit time, except lyric fixes, which merge per song.
 */
import { collection, doc, runTransaction, serverTimestamp, type Firestore } from 'firebase/firestore'
import { ls } from '../lib/idb'
import { tuner } from '../lib/tuner'
import { usePrefs } from '../state/prefs'
import { useSettings, type Settings } from '../state/settings'
import { useLibrary } from '../state/library'

interface Family {
  id: string
  read: () => unknown
  apply: (data: unknown, at: number) => void
  subscribe: (changed: () => void) => () => void
}

/** Settings only the web has (the shared ones sync as the app's own `s_*` records). */
const WEB_SETTINGS: (keyof Settings)[] = ['playerBar', 'moodAutomix', 'vinylMode', 'lyricsScript', 'autoAlignLyrics', 'verifiedOnly', 'dockedPlayer', 'weatherMoods', 'aiDj', 'homeLayout', 'ambientIdle', 'coverBreathing']
const pick = (s: Settings) => Object.fromEntries(WEB_SETTINGS.map((k) => [k, s[k]]))
const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

let applying = false
const stampKey = 'arnav.webStamps'
const stamps = (): Record<string, number> => ls.get<Record<string, number>>(stampKey, {})
const setStamp = (id: string, at: number) => ls.set(stampKey, { ...stamps(), [id]: at })

const FAMILIES: Family[] = [
  {
    id: 'w_automix',
    read: () => usePrefs.getState().playlistAutomix,
    apply: (d, at) => usePrefs.getState().merge('playlistAutomix', d, at),
    subscribe: (cb) => usePrefs.subscribe((s, p) => { if (s.playlistAutomix !== p.playlistAutomix) cb() }),
  },
  {
    id: 'w_glass',
    read: () => usePrefs.getState().glass,
    apply: (d, at) => usePrefs.getState().merge('glass', d, at),
    subscribe: (cb) => usePrefs.subscribe((s, p) => { if (s.glass !== p.glass) cb() }),
  },
  {
    id: 'w_devices',
    read: () => usePrefs.getState().devices,
    apply: (d, at) => usePrefs.getState().merge('devices', d, at),
    subscribe: (cb) => usePrefs.subscribe((s, p) => { if (s.devices !== p.devices) cb() }),
  },
  {
    id: 'w_replay',
    read: () => usePrefs.getState().replay,
    apply: (d, at) => usePrefs.getState().merge('replay', d, at),
    subscribe: (cb) => usePrefs.subscribe((s, p) => { if (s.replay !== p.replay) cb() }),
  },
  {
    id: 'w_lyrics',
    read: () => usePrefs.getState().lyricsFix,
    apply: (d, at) => usePrefs.getState().merge('lyricsFix', d, at),
    subscribe: (cb) => usePrefs.subscribe((s, p) => { if (s.lyricsFix !== p.lyricsFix) cb() }),
  },
  {
    id: 'w_settings',
    read: () => pick(useSettings.getState()),
    apply: (d) => {
      if (!d || typeof d !== 'object') return
      const cur = useSettings.getState()
      const patch: Partial<Settings> = {}
      for (const k of WEB_SETTINGS) {
        const v = (d as Record<string, unknown>)[k]
        if (v !== undefined && typeof v === typeof cur[k]) (patch as Record<string, unknown>)[k] = v
      }
      useSettings.getState().update(patch)
    },
    subscribe: (cb) => useSettings.subscribe((s, p) => { if (!sameJson(pick(s), pick(p))) cb() }),
  },
  {
    id: 'w_library',
    read: () => { const l = useLibrary.getState(); return { notInterested: l.notInterested, blockedArtists: l.blockedArtists, savedRemote: l.savedRemote, recentSearches: l.recentSearches.slice(0, 30) } },
    apply: (d) => {
      if (!d || typeof d !== 'object') return
      const x = d as Record<string, unknown>
      const arr = (v: unknown) => (Array.isArray(v) ? v : null)
      const strs = (v: unknown) => arr(v)?.filter((s): s is string => typeof s === 'string').slice(0, 2000) ?? undefined
      useLibrary.getState().applyRemote({
        ...(strs(x.notInterested) ? { notInterested: strs(x.notInterested) } : {}),
        ...(strs(x.blockedArtists) ? { blockedArtists: strs(x.blockedArtists) } : {}),
        ...(strs(x.recentSearches) ? { recentSearches: strs(x.recentSearches) } : {}),
        ...(arr(x.savedRemote) ? { savedRemote: (arr(x.savedRemote) as { id?: unknown; name?: unknown }[]).filter((r) => typeof r?.id === 'string' && typeof r?.name === 'string') as never } : {}),
      })
    },
    subscribe: (cb) => useLibrary.subscribe((s, p) => {
      if (s.notInterested !== p.notInterested || s.blockedArtists !== p.blockedArtists || s.savedRemote !== p.savedRemote || s.recentSearches !== p.recentSearches) cb()
    }),
  },
  {
    id: 'w_tuner',
    read: () => tuner.stats(),
    apply: (d) => tuner.adopt(d as Parameters<typeof tuner.adopt>[0]),
    subscribe: (cb) => tuner.subscribe(cb),
  },
]
const byId = new Map(FAMILIES.map((f) => [f.id, f]))
const MERGED = new Set(['w_lyrics', 'w_glass', 'w_devices', 'w_replay'])

/** Starts watching local edits; [onEdit] asks for a sync. */
export function watchWebEdits(onEdit: () => void): () => void {
  const offs = FAMILIES.map((f) => f.subscribe(() => {
    if (applying) return
    setStamp(f.id, Date.now())
    onEdit()
  }))
  return () => offs.forEach((o) => o())
}

/** A `w_*` record from another browser. Returns true when it was applied. */
export function applyWebRecord(recordId: string, value: string, fromThisDevice: boolean): boolean {
  const f = byId.get(recordId)
  if (!f || fromThisDevice) return false
  let parsed: { at?: number; data?: unknown }
  try { parsed = JSON.parse(value) } catch { return false }
  const at = Number(parsed.at)
  if (!Number.isFinite(at)) return false
  const mine = stamps()[f.id] ?? 0
  // Lyric fixes, glass, devices and Replays merge per entry (each side keeps what only it has);
  // everything else takes the newer side.
  if (!MERGED.has(f.id) && at <= mine) return false
  applying = true
  try { f.apply(parsed.data, at) } finally { applying = false }
  setStamp(f.id, Math.max(mine, at))
  return true
}

/** Pushes families edited here since the last push. */
export async function pushWeb(db: Firestore, uid: string, deviceId: string, journal: Record<string, { rev: number; value?: string }>): Promise<number> {
  const col = collection(db, 'users', uid, 'liveRecords')
  const st = stamps()
  const pushedKey = `arnav.webPushed.${uid}`
  const pushed = ls.get<Record<string, number>>(pushedKey, {})
  let n = 0
  for (const f of FAMILIES) {
    const at = st[f.id] ?? 0
    if (!at || (pushed[f.id] ?? 0) >= at) continue
    let value = JSON.stringify({ at, data: f.read() })
    if (value.length > 190_000 && f.id === 'w_replay') {
      // Oldest periods go first until it fits.
      const keep = Object.entries(usePrefs.getState().replay).sort((a, b) => b[0].localeCompare(a[0]))
      while (keep.length > 1 && value.length > 190_000) { keep.pop(); value = JSON.stringify({ at, data: Object.fromEntries(keep) }) }
    }
    if (value.length > 190_000) {
      if (f.id !== 'w_lyrics') continue
      // Keep the most recent fixes within the record limit.
      const all = Object.entries(usePrefs.getState().lyricsFix).sort((a, b) => b[1].at - a[1].at)
      value = JSON.stringify({ at, data: Object.fromEntries(all.slice(0, 900)) })
    }
    const rev = await runTransaction(db, async (tx) => {
      const ref = doc(col, f.id)
      const existing = await tx.get(ref)
      const next = Number(existing.exists() ? existing.data().revision ?? 0 : 0) + 1
      tx.set(ref, { kind: 'web', value, revision: next, deleted: false, deviceId, updatedAt: serverTimestamp(), schema: 1 })
      return next
    })
    journal[f.id] = { rev, value }
    pushed[f.id] = at
    n++
  }
  ls.set(pushedKey, pushed)
  return n
}
