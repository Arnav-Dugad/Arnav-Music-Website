import { describe, expect, it } from 'vitest'
import { usePlayer } from '../src/state/player'
import type { Track } from '../src/lib/types'

const t = (n: string) => ({ id: `yt:${n.padEnd(11, 'x')}`, title: n, artist: 'A', genres: [] }) as unknown as Track
const titles = () => usePlayer.getState().queue.map((q) => `${q.track.title}${q.source ? `(${q.source})` : ''}`)

describe('queue order', () => {
  it('plays songs you add after earlier additions, before the rest of the album', () => {
    usePlayer.getState().play([t('a1'), t('a2'), t('a3')], 0)
    usePlayer.getState().addToQueue([t('x')])
    usePlayer.getState().addToQueue([t('y')])
    usePlayer.getState().playNext([t('now')])
    expect(titles()).toEqual(['a1', 'now(you)', 'x(you)', 'y(you)', 'a2', 'a3'])
  })
  it('puts autoplay at the very end, and Undo restores an earlier queue', () => {
    usePlayer.getState().play([t('b1'), t('b2')], 0)
    usePlayer.getState().addAutoplay([t('r1')])
    const before = usePlayer.getState().queue
    usePlayer.getState().clearUpcoming()
    expect(titles()).toEqual(['b1'])
    usePlayer.getState().restore(before)
    expect(titles()).toEqual(['b1', 'b2', 'r1(autoplay)'])
  })
})
