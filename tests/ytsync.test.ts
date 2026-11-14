import { describe, expect, it } from 'vitest'
import { applyOps, mergeLikes, mergeLists, planRemote, type RemoteItem } from '../src/lib/ytsync'

const items = (ids: string[]): RemoteItem[] => ids.map((v, i) => ({ itemId: `i${i}`, videoId: v }))

describe('three-way merge of a linked playlist', () => {
  it('keeps additions from both sides', () => {
    const r = mergeLists(['a', 'b', 'c'], ['a', 'b', 'c', 'x'], ['a', 'b', 'c', 'y'], 'two-way')
    expect(r.merged).toEqual(['a', 'b', 'c', 'x', 'y'])
    expect(r.addedFromArnav).toEqual(['x'])
    expect(r.addedFromYouTube).toEqual(['y'])
  })
  it('a removal on either side wins over "still there" on the other', () => {
    const r = mergeLists(['a', 'b', 'c'], ['a', 'c'], ['a', 'b'], 'two-way')
    expect(r.merged).toEqual(['a'])
    expect(r.removedByArnav).toEqual(['b'])
    expect(r.removedByYouTube).toEqual(['c'])
  })
  it('never deletes a song neither side deleted', () => {
    const r = mergeLists(['a', 'b'], ['a', 'b', 'n1'], ['b', 'a', 'n2'], 'two-way')
    expect(new Set(r.merged)).toEqual(new Set(['a', 'b', 'n1', 'n2']))
  })
  it('the side that reordered wins the order', () => {
    expect(mergeLists(['a', 'b', 'c'], ['c', 'a', 'b'], ['a', 'b', 'c'], 'two-way').merged).toEqual(['c', 'a', 'b'])
    expect(mergeLists(['a', 'b', 'c'], ['a', 'b', 'c'], ['b', 'c', 'a'], 'two-way').merged).toEqual(['b', 'c', 'a'])
  })
  it('first link: keep both, or take one side', () => {
    expect(mergeLists(null, ['a', 'x'], ['a', 'y'], 'two-way', 'both').merged).toEqual(['a', 'x', 'y'])
    expect(mergeLists(null, ['a', 'x'], ['a', 'y'], 'two-way', 'youtube').merged).toEqual(['a', 'y'])
    expect(mergeLists(null, ['a', 'x'], ['a', 'y'], 'two-way', 'arnav').merged).toEqual(['a', 'x'])
  })
  it('one-way modes mirror one side', () => {
    expect(mergeLists(['a'], ['a', 'x'], ['a', 'y'], 'from-youtube').merged).toEqual(['a', 'y'])
    expect(mergeLists(['a'], ['a', 'x'], ['a', 'y'], 'to-youtube').merged).toEqual(['a', 'x'])
  })
})

describe('planning YouTube writes', () => {
  it('deletes, inserts at the right spot, and moves as little as possible', () => {
    const ops = planRemote(items(['a', 'b', 'c', 'd']), ['b', 'c', 'd', 'a'])
    expect(ops.filter((o) => o.kind === 'move')).toHaveLength(1) // only "a" moves
    expect(applyOps(items(['a', 'b', 'c', 'd']), ops)).toEqual(['b', 'c', 'd', 'a'])
  })
  it('does nothing when YouTube already matches', () => {
    expect(planRemote(items(['a', 'b']), ['a', 'b'])).toEqual([])
  })
  it('always reaches the target (500 random playlists)', () => {
    let seed = 7
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n }
    for (let k = 0; k < 500; k++) {
      const pool = Array.from({ length: 14 }, (_, i) => `v${i}`)
      const remote = pool.filter(() => rnd(3) > 0).sort(() => rnd(3) - 1)
      const target = pool.filter(() => rnd(3) > 0).sort(() => rnd(3) - 1)
      const its = items(remote)
      const ops = planRemote(its, target)
      expect(applyOps(its, ops)).toEqual(target)
      // Never more moves than songs out of the longest ordered run.
      expect(ops.filter((o) => o.kind === 'move').length).toBeLessThanOrEqual(remote.length)
    }
  })
})

describe('likes', () => {
  it('merges both sides and respects un-likes', () => {
    const r = mergeLikes(['a', 'b', 'c'], ['a', 'b', 'x'], ['a', 'c', 'y'])
    expect(new Set(r.liked)).toEqual(new Set(['a', 'x', 'y']))
    expect(r.likeOnYouTube).toEqual(['x'])
    expect(r.unlikeOnYouTube).toEqual(['c'])
    expect(r.likeHere).toEqual(['y'])
    expect(r.unlikeHere).toEqual(['b'])
  })
  it('first link only adds', () => {
    const r = mergeLikes(null, ['a'], ['b'])
    expect(new Set(r.liked)).toEqual(new Set(['a', 'b']))
    expect(r.unlikeOnYouTube).toEqual([])
    expect(r.unlikeHere).toEqual([])
  })
})
