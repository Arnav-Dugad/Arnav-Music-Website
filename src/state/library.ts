import { create } from 'zustand'
import { idbGet, idbSet } from '../lib/idb'
import { artistKey, sourceOf, type Like, type PlayEvent, type Playlist, type Track, type TrackId } from '../lib/types'
import { remember, trackRegistry } from './tracks'

export interface LocalEvent extends PlayEvent {
  /** Local identity (web) used to derive the cloud record id. */
  localId: string
  dirty?: boolean
  deleted?: boolean
  /** Device that recorded it (cloud events only). */
  device?: string
}

export interface SyncedLike extends Like { dirty?: boolean }
export interface SyncedPlaylist extends Playlist { dirty?: boolean }

interface LibraryData {
  likes: Record<TrackId, SyncedLike>
  playlists: Record<string, SyncedPlaylist>
  events: LocalEvent[]
  recentSearches: string[]
  notInterested: TrackId[]
  blockedArtists: string[]
  /** Saved remote YouTube playlists (bookmarks, not copies). */
  savedRemote: { id: string; name: string; owner: string; artworkUrl?: string | null; savedAt: number }[]
}

interface LibraryStore extends LibraryData {
  ready: boolean
  /** Bumps whenever data changes that sync cares about. */
  revision: number
  load: () => Promise<void>
  isLiked: (id: TrackId) => boolean
  toggleLike: (t: Track) => boolean
  setLiked: (t: Track, liked: boolean) => void
  createPlaylist: (name: string, tracks?: Track[], description?: string, extra?: Partial<Playlist>) => string
  addToPlaylist: (id: string, tracks: Track[]) => number
  removeFromPlaylist: (id: string, trackId: TrackId) => void
  reorderPlaylist: (id: string, trackIds: TrackId[]) => void
  updatePlaylist: (id: string, patch: Partial<Pick<Playlist, 'name' | 'description' | 'pinned' | 'artworkUrl'>>) => void
  deletePlaylist: (id: string) => void
  recordPlay: (e: Omit<LocalEvent, 'localId'>) => void
  clearHistory: () => void
  removeEvent: (localId: string) => void
  addRecentSearch: (q: string) => void
  clearRecentSearches: () => void
  notInterestedIn: (id: TrackId) => void
  blockArtist: (name: string) => void
  unblock: (kind: 'track' | 'artist', value: string) => void
  toggleSavedRemote: (p: { id: string; name: string; owner: string; artworkUrl?: string | null }) => void
  /** Used by cloud sync. */
  applyRemote: (patch: Partial<LibraryData>) => void
  markClean: (what: { likes?: TrackId[]; playlists?: string[]; events?: string[] }) => void
}

const EMPTY: LibraryData = { likes: {}, playlists: {}, events: [], recentSearches: [], notInterested: [], blockedArtists: [], savedRemote: [] }
let saveTimer: ReturnType<typeof setTimeout> | null = null
const uid = () => (crypto.randomUUID?.() ?? `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`).replace(/-/g, '')

export const useLibrary = create<LibraryStore>()((set, get) => {
  const commit = (patch: Partial<LibraryData>) => {
    set((s) => ({ ...patch, revision: s.revision + 1 }))
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      const { likes, playlists, events, recentSearches, notInterested, blockedArtists, savedRemote } = get()
      void idbSet('library', { likes, playlists, events, recentSearches, notInterested, blockedArtists, savedRemote })
    }, 400)
  }
  const touchPlaylist = (id: string, fn: (p: SyncedPlaylist) => SyncedPlaylist) => {
    const p = get().playlists[id]
    if (!p || p.deleted) return
    commit({ playlists: { ...get().playlists, [id]: { ...fn(p), updatedAt: Date.now(), dirty: true } } })
  }
  return {
    ...EMPTY,
    ready: false,
    revision: 0,
    async load() {
      const saved = await idbGet<Partial<LibraryData>>('library')
      set({ ...EMPTY, ...(saved ?? {}), ready: true })
    },
    isLiked: (id) => {
      const l = get().likes[id]
      return !!l && !l.deleted
    },
    toggleLike(t) {
      const liked = !get().isLiked(t.id)
      get().setLiked(t, liked)
      return liked
    },
    setLiked(t, liked) {
      remember(t)
      const now = Date.now()
      const prev = get().likes[t.id]
      commit({ likes: { ...get().likes, [t.id]: { trackId: t.id, likedAt: liked ? now : prev?.likedAt ?? now, updatedAt: now, deleted: !liked, dirty: true } } })
    },
    createPlaylist(name, tracks = [], description = '', extra = {}) {
      const id = `arn_${uid().slice(0, 16)}`
      remember(tracks)
      const now = Date.now()
      const p: SyncedPlaylist = {
        id, name: name.trim().slice(0, 100) || 'New playlist', description: description.slice(0, 500), kind: 'ARNAV',
        artworkUrl: null, trackIds: [...new Set(tracks.map((t) => t.id))], createdAt: now, updatedAt: now, pinned: false, dirty: true, ...extra,
      }
      commit({ playlists: { ...get().playlists, [id]: p } })
      return id
    },
    addToPlaylist(id, tracks) {
      remember(tracks)
      const p = get().playlists[id]
      if (!p) return 0
      const existing = new Set(p.trackIds)
      const fresh = tracks.map((t) => t.id).filter((tid) => !existing.has(tid))
      touchPlaylist(id, (pl) => ({ ...pl, trackIds: [...pl.trackIds, ...new Set(fresh)].slice(0, 5000) }))
      return fresh.length
    },
    removeFromPlaylist: (id, trackId) => touchPlaylist(id, (p) => ({ ...p, trackIds: p.trackIds.filter((t) => t !== trackId) })),
    reorderPlaylist: (id, trackIds) => touchPlaylist(id, (p) => ({ ...p, trackIds })),
    updatePlaylist: (id, patch) => touchPlaylist(id, (p) => ({ ...p, ...patch, name: (patch.name ?? p.name).slice(0, 100) || p.name })),
    deletePlaylist: (id) => {
      const p = get().playlists[id]
      if (!p) return
      commit({ playlists: { ...get().playlists, [id]: { ...p, deleted: true, updatedAt: Date.now(), dirty: true } } })
    },
    recordPlay(e) {
      if (e.listenedMs < 5000) return
      const ev: LocalEvent = { ...e, localId: `w${uid().slice(0, 15)}`, dirty: true }
      commit({ events: [...get().events, ev] })
    },
    clearHistory: () => commit({ events: get().events.map((e) => ({ ...e, deleted: true, dirty: !!e.cloudId || e.dirty })) }),
    removeEvent: (localId) => commit({ events: get().events.map((e) => (e.localId === localId ? { ...e, deleted: true, dirty: true } : e)) }),
    addRecentSearch(q) {
      const v = q.trim()
      if (v.length < 2) return
      commit({ recentSearches: [v, ...get().recentSearches.filter((x) => x.toLowerCase() !== v.toLowerCase())].slice(0, 12) })
    },
    clearRecentSearches: () => commit({ recentSearches: [] }),
    notInterestedIn: (id) => commit({ notInterested: [...new Set([...get().notInterested, id])] }),
    blockArtist: (name) => commit({ blockedArtists: [...new Set([...get().blockedArtists, artistKey(name)])] }),
    unblock: (kind, value) => kind === 'track'
      ? commit({ notInterested: get().notInterested.filter((x) => x !== value) })
      : commit({ blockedArtists: get().blockedArtists.filter((x) => x !== value) }),
    toggleSavedRemote(p) {
      const has = get().savedRemote.some((x) => x.id === p.id)
      commit({ savedRemote: has ? get().savedRemote.filter((x) => x.id !== p.id) : [{ ...p, savedAt: Date.now() }, ...get().savedRemote] })
    },
    applyRemote: (patch) => commit(patch),
    markClean({ likes, playlists, events }) {
      const s = get()
      const patch: Partial<LibraryData> = {}
      if (likes?.length) {
        const next = { ...s.likes }
        likes.forEach((id) => { if (next[id]) next[id] = { ...next[id], dirty: false } })
        patch.likes = next
      }
      if (playlists?.length) {
        const next = { ...s.playlists }
        playlists.forEach((id) => { if (next[id]) next[id] = { ...next[id], dirty: false } })
        patch.playlists = next
      }
      if (events?.length) {
        const ids = new Set(events)
        patch.events = s.events.map((e) => (ids.has(e.localId) ? { ...e, dirty: false } : e))
      }
      commit(patch)
    },
  }
})

export const lib = () => useLibrary.getState()

/** Live (non-deleted) events, oldest first. */
export function liveEvents(events = lib().events): PlayEvent[] {
  return events.filter((e) => !e.deleted)
}

export function likedIds(likes = lib().likes): Set<TrackId> {
  return new Set(Object.values(likes).filter((l) => !l.deleted).map((l) => l.trackId))
}

export function likedTracks(likes = lib().likes): Track[] {
  return Object.values(likes)
    .filter((l) => !l.deleted)
    .sort((a, b) => b.likedAt - a.likedAt)
    .map((l) => trackRegistry.get(l.trackId))
    .filter((t): t is Track => !!t)
}

export function visiblePlaylists(playlists = lib().playlists): SyncedPlaylist[] {
  return Object.values(playlists)
    .filter((p) => !p.deleted)
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt)
}

/** Recommendation feedback filter: "Not interested" and "Don't recommend this artist". */
export function allows(t: Track, s = lib()): boolean {
  return !s.notInterested.includes(t.id) && !s.blockedArtists.includes(artistKey(t.artist))
}

export const isYouTube = (id: TrackId) => sourceOf(id) === 'YOUTUBE'
