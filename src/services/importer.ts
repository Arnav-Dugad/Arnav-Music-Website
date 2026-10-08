import { create } from 'zustand'
import { idbGet, idbSet } from '../lib/idb'
import { cachedSearch, search, ytQuotaState } from '../lib/youtube'
import { isSingle, titleSimilarity } from '../lib/classify'
import { credited } from '../lib/trust'
import { useUsage } from '../lib/usage'
import { artistKey, type Track, type TrackId } from '../lib/types'
import type { ImportItem, ImportList } from '../lib/importFiles'
import { lib, useLibrary } from '../state/library'
import { trackRegistry } from '../state/tracks'
import { settings } from '../state/settings'
import { verified } from './catalog'

export interface PendingImport { id: string; name: string; kind: ImportList['kind']; playlistId: string | null; items: ImportItem[]; total: number; matched: number; createdAt: number }
export interface ImportRecord { id: string; label: string; source: 'spotify' | 'csv'; createdAt: number; playlistIds: string[]; likedIds: TrackId[]; matched: number; total: number; undone?: boolean }

interface ImportState {
  pending: PendingImport[]
  history: ImportRecord[]
  running: { label: string; done: number; total: number } | null
  load: () => Promise<void>
}

export const useImports = create<ImportState>()((set) => ({
  pending: [],
  history: [],
  running: null,
  async load() {
    set({ pending: (await idbGet<PendingImport[]>('imports_pending')) ?? [], history: (await idbGet<ImportRecord[]>('imports_history')) ?? [] })
  },
}))
void useImports.getState().load()

const save = async () => {
  const { pending, history } = useImports.getState()
  await idbSet('imports_pending', pending)
  await idbSet('imports_history', history)
}

/** Picks the best official upload of [item] from [pool]. */
export function bestMatch(item: ImportItem, pool: Track[]): Track | null {
  const cands = verified(pool).filter((t) => isSingle(t) && titleSimilarity(t.title, item.title) >= 0.6
    && (credited(t, item.artist) || titleSimilarity(t.artist, item.artist) >= 0.5 || (t.rawTitle ?? '').toLowerCase().includes(item.artist.toLowerCase()))
    && (!item.durationMs || !t.durationMs || Math.abs(t.durationMs - item.durationMs) <= 15_000))
  cands.sort((a, b) =>
    (b.trust ?? 1) - (a.trust ?? 1)
    || (a.variant === 'SONG' ? 0 : 1) - (b.variant === 'SONG' ? 0 : 1)
    || titleSimilarity(b.title, item.title) - titleSimilarity(a.title, item.title)
    || (item.durationMs ? Math.abs((a.durationMs ?? 0) - item.durationMs) - Math.abs((b.durationMs ?? 0) - item.durationMs) : 0))
  return cands[0] ?? null
}

/** How many new YouTube searches this run may spend (each is ~101 units with details). */
function searchBudget(): number {
  const used = useUsage.getState().units
  const budget = settings().youtubeDailyBudget || 10000
  if (ytQuotaState() !== 'NORMAL') return 0
  return Math.max(0, Math.min(80, Math.floor(((budget - used) * 0.5) / 101)))
}

/** Library tracks by every credited artist key, built once per import run. */
let index: Map<string, Track[]> | null = null
function buildIndex() {
  index = new Map()
  for (const t of trackRegistry.all()) {
    for (const name of t.artist.split(/,|&| x | feat\.? | ft\.? /i)) {
      const k = artistKey(name)
      if (!k) continue
      const l = index.get(k) ?? []
      l.push(t)
      index.set(k, l)
    }
  }
}

async function matchItem(item: ImportItem, allowRemote: boolean): Promise<{ track: Track | null; usedRemote: boolean }> {
  const local = bestMatch(item, index?.get(artistKey(item.artist)) ?? [])
  if (local) return { track: local, usedRemote: false }
  const q = `${item.artist} ${item.title}`.slice(0, 100)
  const c = await cachedSearch(q, 'SONGS')
  if (c) return { track: bestMatch(item, c.tracks), usedRemote: false }
  if (!allowRemote) return { track: null, usedRemote: false }
  try { return { track: bestMatch(item, (await search(q, 'SONGS')).tracks), usedRemote: true } } catch { return { track: null, usedRemote: true } }
}

/** Matches as many items as the quota allows; the rest stay pending for tomorrow. */
async function work(p: PendingImport, record: ImportRecord, onProgress: (done: number) => void): Promise<PendingImport> {
  buildIndex()
  let budget = searchBudget()
  const left: ImportItem[] = []
  const found: Track[] = []
  let done = 0
  for (const item of p.items) {
    const allow = budget > 0
    const { track, usedRemote } = await matchItem(item, allow)
    if (usedRemote) budget--
    if (track) found.push(track)
    else if (!allow) left.push(item) // not tried yet — retry when quota is back
    onProgress(++done)
  }
  if (p.kind === 'liked') {
    for (const t of found) if (!lib().isLiked(t.id)) { lib().setLiked(t, true); record.likedIds.push(t.id) }
  } else if (p.playlistId) {
    lib().addToPlaylist(p.playlistId, found)
  }
  record.matched += found.length
  return { ...p, items: left, matched: p.matched + found.length }
}

export async function runImport(lists: ImportList[], source: 'spotify' | 'csv'): Promise<ImportRecord> {
  const record: ImportRecord = { id: `imp_${Date.now().toString(36)}`, label: lists.length === 1 ? lists[0].name : `${lists.length} playlists`, source, createdAt: Date.now(), playlistIds: [], likedIds: [], matched: 0, total: lists.reduce((a, l) => a + l.items.length, 0) }
  const total = record.total
  let base = 0
  useImports.setState({ running: { label: record.label, done: 0, total } })
  const pend: PendingImport[] = []
  try {
    for (const l of lists) {
      const playlistId = l.kind === 'liked' ? null : lib().createPlaylist(l.name, [], source === 'spotify' ? 'Imported from Spotify' : 'Imported from CSV')
      if (playlistId) record.playlistIds.push(playlistId)
      const p: PendingImport = { id: `${record.id}_${pend.length}`, name: l.name, kind: l.kind, playlistId, items: l.items, total: l.items.length, matched: 0, createdAt: Date.now() }
      const after = await work(p, record, (d) => useImports.setState({ running: { label: l.name, done: base + d, total } }))
      base += l.items.length
      if (after.items.length) pend.push(after)
    }
  } finally {
    useImports.setState((s) => ({ running: null, pending: [...s.pending, ...pend], history: [record, ...s.history].slice(0, 50) }))
    await save()
  }
  return record
}

/** Continues pending imports with today's quota. */
export async function resumePending(): Promise<number> {
  const { pending, history } = useImports.getState()
  if (!pending.length) return 0
  const total = pending.reduce((a, p) => a + p.items.length, 0)
  let base = 0
  let matched = 0
  const still: PendingImport[] = []
  useImports.setState({ running: { label: 'Continuing imports', done: 0, total } })
  try {
    for (const p of pending) {
      const rec = history.find((h) => p.id.startsWith(h.id)) ?? { id: p.id, label: p.name, source: 'spotify' as const, createdAt: p.createdAt, playlistIds: [], likedIds: [], matched: 0, total: p.total }
      const before = rec.matched
      const after = await work(p, rec, (d) => useImports.setState({ running: { label: p.name, done: base + d, total } }))
      matched += rec.matched - before
      base += p.items.length
      if (after.items.length) still.push(after)
    }
  } finally {
    useImports.setState({ running: null, pending: still, history: [...history] })
    await save()
  }
  return matched
}

/** Undo an import: removes its playlists and the likes it added (if still liked). */
export async function undoImport(id: string): Promise<void> {
  const s = useImports.getState()
  const rec = s.history.find((h) => h.id === id)
  if (!rec || rec.undone) return
  for (const pid of rec.playlistIds) lib().deletePlaylist(pid)
  for (const tid of rec.likedIds) { const t = trackRegistry.get(tid); if (t && lib().isLiked(tid)) lib().setLiked(t, false) }
  useImports.setState({ history: s.history.map((h) => (h.id === id ? { ...h, undone: true } : h)), pending: s.pending.filter((p) => !p.id.startsWith(id)) })
  await save()
}

/** Redo a previously undone import (restores its playlists and likes). */
export async function redoImport(id: string): Promise<void> {
  const s = useImports.getState()
  const rec = s.history.find((h) => h.id === id)
  if (!rec || !rec.undone) return
  const pls = { ...useLibrary.getState().playlists }
  for (const pid of rec.playlistIds) if (pls[pid]) pls[pid] = { ...pls[pid], deleted: false, updatedAt: Date.now(), dirty: true }
  useLibrary.getState().applyRemote({ playlists: pls })
  for (const tid of rec.likedIds) { const t = trackRegistry.get(tid); if (t) lib().setLiked(t, true) }
  useImports.setState({ history: s.history.map((h) => (h.id === id ? { ...h, undone: false } : h)) })
  await save()
}

// ── Duplicate finder ────────────────────────────────────────────────────────
export interface DuplicateGroup { key: string; versions: { track: Track; uses: number; liked: boolean }[] }

const songKey = (t: Track) => `${t.title.toLowerCase().replace(/\(.*?\)|\[.*?\]/g, '').replace(/[^\p{L}\p{N}]/gu, '')}|${artistKey(t.artist.split(/,|&/)[0] ?? t.artist)}`

/** The same song saved as different uploads across likes and playlists. */
export function findDuplicates(): DuplicateGroup[] {
  const s = useLibrary.getState()
  const uses = new Map<TrackId, number>()
  for (const p of Object.values(s.playlists)) if (!p.deleted) for (const id of p.trackIds) uses.set(id, (uses.get(id) ?? 0) + 1)
  const liked = new Set(Object.values(s.likes).filter((l) => !l.deleted).map((l) => l.trackId))
  const ids = new Set([...uses.keys(), ...liked])
  const groups = new Map<string, Track[]>()
  for (const t of trackRegistry.many([...ids])) {
    const k = songKey(t)
    const g = groups.get(k) ?? []
    g.push(t)
    groups.set(k, g)
  }
  return [...groups.entries()]
    .filter(([, g]) => g.length > 1 && g.every((t) => !g[0].durationMs || !t.durationMs || Math.abs(t.durationMs - g[0].durationMs) < 40_000))
    .map(([key, g]) => ({ key, versions: g.map((t) => ({ track: t, uses: uses.get(t.id) ?? 0, liked: liked.has(t.id) })).sort((a, b) => (b.track.trust ?? 1) - (a.track.trust ?? 1) || b.uses - a.uses) }))
}

export interface DedupeUndo { playlists: Record<string, TrackId[]>; likes: { id: TrackId; liked: boolean }[] }

/** "Keep this version": replaces the other versions everywhere. Returns what's needed to undo it. */
export function keepVersion(group: DuplicateGroup, keep: Track): DedupeUndo {
  const others = new Set(group.versions.map((v) => v.track.id).filter((id) => id !== keep.id))
  const s = useLibrary.getState()
  const undo: DedupeUndo = { playlists: {}, likes: [] }
  for (const p of Object.values(s.playlists)) {
    if (p.deleted || !p.trackIds.some((id) => others.has(id))) continue
    undo.playlists[p.id] = p.trackIds
    const next: TrackId[] = []
    for (const id of p.trackIds) {
      const mapped = others.has(id) ? keep.id : id
      if (!next.includes(mapped)) next.push(mapped)
    }
    lib().reorderPlaylist(p.id, next)
  }
  const anyLiked = group.versions.some((v) => v.liked)
  for (const v of group.versions) {
    if (v.track.id === keep.id) continue
    if (v.liked) { undo.likes.push({ id: v.track.id, liked: true }); lib().setLiked(v.track, false) }
  }
  if (anyLiked && !lib().isLiked(keep.id)) { undo.likes.push({ id: keep.id, liked: false }); lib().setLiked(keep, true) }
  return undo
}

export function undoDedupe(u: DedupeUndo) {
  for (const [pid, ids] of Object.entries(u.playlists)) lib().reorderPlaylist(pid, ids)
  for (const l of u.likes) { const t = trackRegistry.get(l.id); if (t) lib().setLiked(t, l.liked) }
}
