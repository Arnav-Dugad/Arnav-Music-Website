/**
 * YouTube Music ↔ Arnav sync planning: pure functions, no I/O (tested in tests/ytsync.test.ts).
 *
 * Every linked playlist keeps a `base`: the song list both sides agreed on at the last sync. A
 * sync compares Arnav now and YouTube now against it (a three-way merge), so additions and removals
 * made on either side all survive, and nothing is deleted that one side didn't delete.
 *
 * The base only moves forward when YouTube really reached the merged state; a sync cut short (the
 * daily quota, an expired pass) simply finishes next time from the same base.
 */

export type SyncMode = 'two-way' | 'from-youtube' | 'to-youtube'
/** First link: keep the songs from both sides, or make one side match the other. */
export type FirstLink = 'both' | 'youtube' | 'arnav'

const uniq = (xs: string[]) => [...new Set(xs)]

/** True when the items both lists share appear in the same relative order. */
function sameRelativeOrder(a: string[], b: string[]): boolean {
  const inB = new Set(b)
  const inA = new Set(a)
  const x = a.filter((v) => inB.has(v))
  const y = b.filter((v) => inA.has(v))
  return x.length === y.length && x.every((v, i) => v === y[i])
}

/**
 * The order of [keep]: [primary]'s order first; songs only the other side has go right after the
 * song that precedes them there (a song added at the end stays at the end).
 */
function weave(primary: string[], secondary: string[], keep: Set<string>): string[] {
  const out = primary.filter((v) => keep.has(v))
  const placed = new Set(out)
  let prev: string | null = null
  for (const v of secondary) {
    if (!keep.has(v)) continue
    if (!placed.has(v)) {
      const at = prev == null ? 0 : out.indexOf(prev) + 1
      out.splice(at, 0, v)
      placed.add(v)
    }
    prev = v
  }
  // Anything left (only possible when a song is in neither list's order) goes last.
  for (const v of keep) if (!placed.has(v)) out.push(v)
  return out
}

export interface MergeResult {
  /** The song list (video ids) both sides should end up with, in order. */
  merged: string[]
  addedFromYouTube: string[]
  removedByYouTube: string[]
  addedFromArnav: string[]
  removedByArnav: string[]
}

/**
 * Three-way merge of video-id lists. `base` null means the first link: [first] decides.
 * Duplicates are collapsed (an Arnav playlist holds each song once).
 */
export function mergeLists(base: string[] | null, local: string[], remote: string[], mode: SyncMode, first: FirstLink = 'both'): MergeResult {
  const L = uniq(local)
  const R = uniq(remote)
  const none = { addedFromYouTube: [], removedByYouTube: [], addedFromArnav: [], removedByArnav: [] }
  if (mode === 'from-youtube' || (base == null && first === 'youtube')) {
    const inL = new Set(L)
    const inR = new Set(R)
    return { ...none, merged: R, addedFromYouTube: R.filter((v) => !inL.has(v)), removedByYouTube: L.filter((v) => !inR.has(v)) }
  }
  if (mode === 'to-youtube' || (base == null && first === 'arnav')) {
    const inL = new Set(L)
    const inR = new Set(R)
    return { ...none, merged: L, addedFromArnav: L.filter((v) => !inR.has(v)), removedByArnav: R.filter((v) => !inL.has(v)) }
  }
  if (base == null) {
    // Keep both: YouTube's order, with Arnav-only songs woven in.
    const keep = new Set([...R, ...L])
    const merged = weave(R, L, keep)
    const inR = new Set(R)
    const inL = new Set(L)
    return { ...none, merged, addedFromArnav: L.filter((v) => !inR.has(v)), addedFromYouTube: R.filter((v) => !inL.has(v)) }
  }
  const B = new Set(uniq(base))
  const inL = new Set(L)
  const inR = new Set(R)
  const addedFromArnav = L.filter((v) => !B.has(v) && !inR.has(v))
  const addedFromYouTube = R.filter((v) => !B.has(v) && !inL.has(v))
  const removedByArnav = [...B].filter((v) => !inL.has(v) && inR.has(v))
  const removedByYouTube = [...B].filter((v) => !inR.has(v) && inL.has(v))
  const keep = new Set<string>()
  for (const v of [...L, ...R]) keep.add(v)
  for (const v of B) if (!inL.has(v) || !inR.has(v)) keep.delete(v) // removed on either side
  // Whichever side reordered wins the order; when both did (or neither), YouTube's is kept.
  const baseList = uniq(base)
  const localMoved = !sameRelativeOrder(baseList, L)
  const remoteMoved = !sameRelativeOrder(baseList, R)
  const [primary, secondary] = localMoved && !remoteMoved ? [L, R] : [R, L]
  return { merged: weave(primary, secondary, keep), addedFromArnav, addedFromYouTube, removedByArnav, removedByYouTube }
}

/** One write to YouTube (each costs 50 quota units). */
export type RemoteOp =
  | { kind: 'delete'; itemId: string; videoId: string }
  | { kind: 'insert'; videoId: string; position: number }
  | { kind: 'move'; itemId: string; videoId: string; position: number }

export interface RemoteItem { itemId: string; videoId: string }

/** Indices (into seq) of a longest strictly increasing subsequence. */
function lisIndices(seq: number[]): Set<number> {
  const tails: number[] = []
  const tailIdx: number[] = []
  const prev = new Array<number>(seq.length).fill(-1)
  seq.forEach((x, i) => {
    let lo = 0
    let hi = tails.length
    while (lo < hi) { const m = (lo + hi) >> 1; if (tails[m] < x) lo = m + 1; else hi = m }
    tails[lo] = x
    tailIdx[lo] = i
    prev[i] = lo > 0 ? tailIdx[lo - 1] : -1
  })
  const out = new Set<number>()
  let k = tailIdx[tails.length - 1] ?? -1
  while (k >= 0) { out.add(k); k = prev[k] }
  return out
}

/**
 * The writes that turn YouTube's playlist ([items], in order) into [target]: deletions first, then
 * insertions at their final position, then the fewest moves for songs out of order (every song in
 * the longest already-ordered run stays put). Extra copies of a song on YouTube are left alone
 * unless the song itself goes.
 */
export function planRemote(items: RemoteItem[], target: string[]): RemoteOp[] {
  const want = new Set(target)
  const ops: RemoteOp[] = []
  // 1. Deletions: every copy of a song that's no longer wanted.
  const real: string[] = []
  const itemOf = new Map<string, string>()
  for (const it of items) {
    if (!want.has(it.videoId)) { ops.push({ kind: 'delete', itemId: it.itemId, videoId: it.videoId }); continue }
    real.push(it.videoId)
    if (!itemOf.has(it.videoId)) itemOf.set(it.videoId, it.itemId)
  }
  // 2. Which songs already there may stay: the longest run already in target order.
  const rank = new Map(target.map((v, i) => [v, i]))
  const firsts = [...new Set(real)]
  const stay = lisIndices(firsts.map((v) => rank.get(v) ?? 0))
  const movers = new Set(firsts.filter((_, i) => !stay.has(i)))
  // 3. In target order, each new or out-of-order song goes right after its predecessor, with its
  // position counted in YouTube's list as it is at that moment (so the ops run one after another).
  for (let t = 0; t < target.length; t++) {
    const v = target[t]
    const isNew = !itemOf.has(v)
    if (!isNew && !movers.has(v)) continue
    if (!isNew) real.splice(real.indexOf(v), 1)
    const pred = t > 0 ? real.indexOf(target[t - 1]) : -1
    const position = pred + 1
    real.splice(position, 0, v)
    ops.push(isNew ? { kind: 'insert', videoId: v, position } : { kind: 'move', itemId: itemOf.get(v)!, videoId: v, position })
  }
  return ops
}

/** What YouTube's list becomes after [ops] (used by tests and to check a plan). */
export function applyOps(items: RemoteItem[], ops: RemoteOp[]): string[] {
  const list = items.map((i) => ({ ...i }))
  let n = 0
  for (const op of ops) {
    if (op.kind === 'delete') { const i = list.findIndex((x) => x.itemId === op.itemId); if (i >= 0) list.splice(i, 1) }
    else if (op.kind === 'insert') list.splice(op.position, 0, { itemId: `new${n++}`, videoId: op.videoId })
    else { const i = list.findIndex((x) => x.itemId === op.itemId); const [m] = list.splice(i, 1); list.splice(op.position, 0, m) }
  }
  return list.map((x) => x.videoId)
}

/** Likes are a set: songs liked on either side stay liked unless one side un-liked them. */
export function mergeLikes(base: string[] | null, local: string[], remote: string[]): { liked: string[]; likeOnYouTube: string[]; unlikeOnYouTube: string[]; likeHere: string[]; unlikeHere: string[] } {
  const L = new Set(local)
  const R = new Set(remote)
  const B = base ? new Set(base) : null
  const liked = new Set<string>([...L, ...R])
  if (B) for (const v of B) if (!L.has(v) || !R.has(v)) liked.delete(v)
  const final = [...liked]
  return {
    liked: final,
    likeOnYouTube: final.filter((v) => !R.has(v)),
    unlikeOnYouTube: [...R].filter((v) => !liked.has(v)),
    likeHere: final.filter((v) => !L.has(v)),
    unlikeHere: [...L].filter((v) => !liked.has(v)),
  }
}

/** Quota units for a plan (YouTube Data API: every write is 50). */
export const opCost = (_op: RemoteOp) => 50
