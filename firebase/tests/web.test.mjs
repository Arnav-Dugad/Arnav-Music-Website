// Web edition: replays the website's exact Firestore payloads (from src/services/sync.ts)
// and checks the new hardening rejects what it should.
import { test, before, after, beforeEach } from 'node:test'
import { readFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing'
import { doc, setDoc, writeBatch, runTransaction, serverTimestamp, getDocs, query, where, orderBy, limit, collection, Timestamp } from 'firebase/firestore'

let env
const now = Date.now()
const deviceId = randomUUID()
const track = { id: 'yt:4NRXx6U8ABQ', title: 'Blinding Lights', artist: 'The Weeknd', album: 'After Hours', durationMs: 262000, artworkUrl: 'https://i.ytimg.com/vi/4NRXx6U8ABQ/hqdefault.jpg', playbackRef: '4NRXx6U8ABQ', channelId: 'UC0WP5P-ufpRfjbNrmOWwLBQ', genres: ['pop'] }
const trackToMap = (t) => ({ id: t.id, title: t.title, artist: t.artist, album: t.album ?? null, durationMs: t.durationMs ?? null, artworkUrl: t.artworkUrl ?? null, playbackRef: t.playbackRef, channelId: t.channelId ?? null, genres: (t.genres ?? []).join('|') })
const like = (id, t = track, extra = {}) => ({ trackId: id, likedAt: now, updatedAt: now, deleted: false, track: t ? trackToMap(t) : null, ...extra })
const playlist = (extra = {}) => ({ name: 'Late night drive', description: 'Neon', kind: 'ARNAV', artworkUrl: null, pinned: true, createdAt: now, updatedAt: now, deleted: false, tracks: [trackToMap(track)], ...extra })

before(async () => {
  env = await initializeTestEnvironment({ projectId: 'demo-arnav-music', firestore: { rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8') } })
})
after(async () => env && env.cleanup())
beforeEach(async () => env.clearFirestore())

test('web: likes (batch merge, tombstone, sparse track)', async () => {
  const db = env.authenticatedContext('alice').firestore()
  const b = writeBatch(db)
  b.set(doc(db, 'users/alice/likes', track.id), like(track.id), { merge: true })
  await assertSucceeds(b.commit())
  await assertSucceeds(setDoc(doc(db, 'users/alice/likes', track.id), like(track.id, track, { deleted: true, updatedAt: now + 1 }), { merge: true }))
  const sparse = { ...track, id: 'yt:XXYlFuWEuKI', playbackRef: 'XXYlFuWEuKI', album: null, channelId: null, genres: [] }
  await assertSucceeds(setDoc(doc(db, 'users/alice/likes', sparse.id), like(sparse.id, sparse)))
  await assertSucceeds(setDoc(doc(db, 'users/alice/likes', 'yt:Zx9_-aBcDeF'), like('yt:Zx9_-aBcDeF', null)))
})

test('web: playlists (arn_, ytimp_, imp_)', async () => {
  const db = env.authenticatedContext('alice').firestore()
  for (const id of ['arn_0123456789abcdef', 'ytimp_PLabc-DEF_123', 'imp_0123456789abcdef']) {
    await assertSucceeds(setDoc(doc(db, 'users/alice/playlists', id), playlist()))
  }
})

test('web: history + queue live records and sync queries', async () => {
  const db = env.authenticatedContext('alice').firestore()
  const listen = { trackId: track.id, artistKey: 'theweeknd', startedAt: now - 300000, listenedMs: 200000, durationMs: 262000, completed: false, skipped: false, source: 'YOUTUBE', title: track.title, artist: track.artist, album: track.album }
  const hid = 'h_' + createHash('sha256').update(`${deviceId}:wabc:${listen.startedAt}:${track.id}`).digest('hex')
  const push = (deleted) => runTransaction(db, async (tx) => {
    const ref = doc(db, 'users/alice/liveRecords', hid)
    const ex = await tx.get(ref); const e = ex.exists() ? ex.data() : null
    tx.set(ref, { kind: 'history', value: e?.value ?? JSON.stringify(listen), revision: Number(e?.revision ?? 0) + 1, deleted: !!e?.deleted || deleted, deviceId: e?.deviceId ?? deviceId, updatedAt: serverTimestamp(), schema: 1 })
  })
  await assertSucceeds(push(false))
  await assertSucceeds(push(true))
  const kt = { ...track, energy: 0.8, year: 2019, variant: 'SONG', credits: null, compilation: false, trackNumber: null, discNumber: null, albumId: null, albumArtist: null }
  const queue = () => runTransaction(db, async (tx) => {
    const ref = doc(db, 'users/alice/liveRecords/q_shared'); const ex = await tx.get(ref)
    tx.set(ref, { kind: 'queue', value: JSON.stringify({ tracks: [kt], index: 0 }), revision: Number(ex.exists() ? ex.data().revision ?? 0 : 0) + 1, deleted: false, deviceId, updatedAt: serverTimestamp(), schema: 1 })
  })
  await assertSucceeds(queue())
  await assertSucceeds(queue())
  await assertSucceeds(getDocs(query(collection(db, 'users/alice/likes'), where('updatedAt', '>', 0))))
  await assertSucceeds(getDocs(query(collection(db, 'users/alice/liveRecords'), where('updatedAt', '>=', Timestamp.fromMillis(0)), orderBy('updatedAt'), limit(300))))
  await assertSucceeds(getDocs(query(collection(db, 'users/alice/liveRecords'), orderBy('updatedAt', 'desc'), limit(1))))
})

test('web: settings records the Android app reads (create + update, allowlisted ids only)', async () => {
  const db = env.authenticatedContext('alice').firestore()
  const push = (id, value) => runTransaction(db, async (tx) => {
    const ref = doc(db, 'users/alice/liveRecords', id)
    const ex = await tx.get(ref)
    tx.set(ref, { kind: 'setting', value, revision: Number(ex.exists() ? ex.data().revision ?? 0 : 0) + 1, deleted: false, deviceId, updatedAt: serverTimestamp(), schema: 1 })
  })
  for (const [id, value] of [['s_themeMode', '"DARK"'], ['s_presetAccent', String((0xff << 24 | 0x52d6c3) | 0)], ['s_selectedMoods', '["FOCUS","UPBEAT"]'],
    ['s_dailyAiLimit', '40'], ['s_ambientEdgeGlow', 'true'], ['s_regionCode', '"IN"'], ['s_seedArtists', '["Arijit Singh"]'], ['s_glass', '"SUBTLE"'], ['s_motion', '"MINIMAL"']]) {
    await assertSucceeds(push(id, value))
  }
  await assertSucceeds(push('s_themeMode', '"LIGHT"'))
  await assertFails(push('s_cloudSync', 'false'))
  await assertFails(push('s_youtubeKey', '"secret"'))
})

test('hardening: rejects malformed like ids, mismatched tracks and bad playlist ids', async () => {
  const db = env.authenticatedContext('alice').firestore()
  await assertFails(setDoc(doc(db, 'users/alice/likes/local:1234'), like('local:1234', null)))
  await assertFails(setDoc(doc(db, 'users/alice/likes/anything'), like('anything', null)))
  await assertFails(setDoc(doc(db, 'users/alice/likes', track.id), like(track.id, { ...track, id: 'yt:someOtherId' })))
  await assertFails(setDoc(doc(db, 'users/alice/likes', track.id), like(track.id, { ...track, playbackRef: '<script>' })))
  await assertFails(setDoc(doc(db, 'users/alice/playlists/bad id!'), playlist()))
  await assertFails(setDoc(doc(db, 'users/alice/playlists/a.b'), playlist()))
})
