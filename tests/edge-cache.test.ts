import { describe, expect, it } from 'vitest'
import { cached, overLimit, type ApiEnv } from '../server/util'

/** An in-memory stand-in for a KV namespace (values + metadata). */
function fakeKv() {
  const store = new Map<string, { value: string; metadata: unknown }>()
  const kv = {
    store,
    puts: 0,
    async getWithMetadata(key: string) { const e = store.get(key); return e ? { value: e.value, metadata: e.metadata } : { value: null, metadata: null } },
    async get(key: string) { return store.get(key)?.value ?? null },
    async put(key: string, value: string, opts?: { metadata?: unknown }) { kv.puts++; store.set(key, { value, metadata: opts?.metadata ?? null }) },
  }
  return kv
}
const envWith = (kv: ReturnType<typeof fakeKv>) => ({ YT_CACHE: kv as unknown as KVNamespace }) as ApiEnv

describe('shared cache', () => {
  it('serves a fresh copy without calling upstream', async () => {
    const kv = fakeKv()
    kv.store.set('k', { value: 'cached', metadata: { at: Date.now() } })
    let calls = 0
    const r = await cached(envWith(kv), 'k', 60, async () => { calls++; return { status: 200, body: 'new' } })
    expect(r).toMatchObject({ body: 'cached', hit: true })
    expect(calls).toBe(0)
  })
  it('refreshes a stale copy when upstream works', async () => {
    const kv = fakeKv()
    kv.store.set('k', { value: 'old', metadata: { at: Date.now() - 120_000 } })
    const r = await cached(envWith(kv), 'k', 60, async () => ({ status: 200, body: 'new' }))
    expect(r).toMatchObject({ body: 'new', hit: false })
    expect(kv.store.get('k')?.value).toBe('new')
  })
  it('serves the stale copy when upstream fails (quota, outage, timeout)', async () => {
    const kv = fakeKv()
    kv.store.set('k', { value: 'old', metadata: { at: Date.now() - 120_000 } })
    expect(await cached(envWith(kv), 'k', 60, async () => ({ status: 429, body: 'quota' }))).toMatchObject({ status: 200, body: 'old', stale: true })
    expect(await cached(envWith(kv), 'k', 60, async () => { throw new Error('timeout') })).toMatchObject({ status: 200, body: 'old', stale: true })
  })
  it('passes errors through when nothing is saved, and never stores them', async () => {
    const kv = fakeKv()
    expect(await cached(envWith(kv), 'k', 60, async () => ({ status: 404, body: 'nope' }))).toMatchObject({ status: 404, hit: false })
    expect(kv.puts).toBe(0)
  })
  it('shares one upstream call between identical requests in flight', async () => {
    const kv = fakeKv()
    let calls = 0
    const load = async () => { calls++; await new Promise((r) => setTimeout(r, 20)); return { status: 200, body: 'x' } }
    const [a, b, c] = await Promise.all([cached(envWith(kv), 'same', 60, load), cached(envWith(kv), 'same', 60, load), cached(envWith(kv), 'same', 60, load)])
    expect(calls).toBe(1)
    expect([a.body, b.body, c.body]).toEqual(['x', 'x', 'x'])
  })
  it('keeps entries longer than their freshness, stamped with when they were fetched', async () => {
    const kv = fakeKv()
    await cached(envWith(kv), 'k', 60, async () => ({ status: 200, body: 'x' }))
    expect((kv.store.get('k')?.metadata as { at: number }).at).toBeGreaterThan(Date.now() - 1000)
  })
})

describe('fair-use limit', () => {
  it('allows up to the limit in a window, then refuses', () => {
    const key = `t:${Math.random()}`
    for (let i = 0; i < 5; i++) expect(overLimit(key, 5, 60_000)).toBe(false)
    expect(overLimit(key, 5, 60_000)).toBe(true)
  })
})
