// Security-rules tests run against the local Firestore emulator (no project, no billing).
import { test, before, after, beforeEach } from 'node:test';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { doc, setDoc, getDoc, deleteDoc, serverTimestamp, writeBatch } from 'firebase/firestore';

let env;
const now = Date.now();
const like = (id, extra = {}) => ({ trackId: id, likedAt: now, updatedAt: now, deleted: false, track: { id, title: 'Song', artist: 'Artist', playbackRef: 'abcdefghijk' }, ...extra });
const playlist = (extra = {}) => ({ name: 'Mix', description: '', kind: 'ARNAV', artworkUrl: null, pinned: false, createdAt: now, updatedAt: now, deleted: false, tracks: [], ...extra });

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-arnav-music',
    firestore: { rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8') },
  });
});
after(async () => env && env.cleanup());
beforeEach(async () => env.clearFirestore());

test('owner can write and read their like', async () => {
  const db = env.authenticatedContext('alice').firestore();
  await assertSucceeds(setDoc(doc(db, 'users/alice/likes/yt:abcdefghijk'), like('yt:abcdefghijk')));
  await assertSucceeds(getDoc(doc(db, 'users/alice/likes/yt:abcdefghijk')));
});

test('other users cannot read or write someone else\'s data', async () => {
  await env.withSecurityRulesDisabled(async (ctx) => setDoc(doc(ctx.firestore(), 'users/alice/likes/yt:x'), like('yt:x')));
  const mallory = env.authenticatedContext('mallory').firestore();
  await assertFails(getDoc(doc(mallory, 'users/alice/likes/yt:x')));
  await assertFails(setDoc(doc(mallory, 'users/alice/likes/yt:y'), like('yt:y')));
  await assertFails(deleteDoc(doc(mallory, 'users/alice/likes/yt:x')));
});

test('unauthenticated access is denied', async () => {
  const anon = env.unauthenticatedContext().firestore();
  await assertFails(getDoc(doc(anon, 'users/alice')));
  await assertFails(setDoc(doc(anon, 'users/alice/likes/yt:z'), like('yt:z')));
});

test('rejects unknown fields, wrong types and oversized data', async () => {
  const db = env.authenticatedContext('alice').firestore();
  await assertFails(setDoc(doc(db, 'users/alice/likes/yt:a'), like('yt:a', { extra: 1 })));
  await assertFails(setDoc(doc(db, 'users/alice/likes/yt:a'), like('yt:a', { deleted: 'no' })));
  await assertFails(setDoc(doc(db, 'users/alice/likes/yt:a'), like('yt:b')));
  await assertFails(setDoc(doc(db, 'users/alice/playlists/p1'), playlist({ name: 'x'.repeat(101) })));
  await assertFails(setDoc(doc(db, 'users/alice/playlists/p1'), playlist({ tracks: new Array(501).fill({}) })));
  await assertFails(setDoc(doc(db, 'users/alice/playlists/p1'), playlist({ kind: 'YOUTUBE' })));
  await assertSucceeds(setDoc(doc(db, 'users/alice/playlists/p1'), playlist()));
});

test('profile document is validated and unmodelled paths are denied', async () => {
  const db = env.authenticatedContext('alice').firestore();
  await assertSucceeds(setDoc(doc(db, 'users/alice'), { displayName: 'Alice', settings: '{}', updatedAt: now, schema: 1 }));
  await assertFails(setDoc(doc(db, 'users/alice'), { displayName: 'Alice', updatedAt: now, schema: 1, isAdmin: true }));
  await assertFails(setDoc(doc(db, 'users/alice/history/h1'), { any: 1 }));
  await assertFails(setDoc(doc(db, 'global/config'), { any: 1 }));
});

const deviceId = '12345678-1234-1234-1234-123456789abc';
const hash = 'a'.repeat(64);
const backupId = deviceId + '_' + hash;
const tables = ['tracks','likes','playlists','playlist_tracks','play_events','search_cache','recent_searches','ai_cache','kv_sync','lyrics','audio_features','pending_matches','import_history','tag_overrides','rec_feedback','skip_marks'];
const chunk = (extra = {}) => ({ hash, payload: 'YQ==', bytes: 1, schema: 1, createdAt: serverTimestamp(), ...extra });
const backup = (extra = {}) => ({ schema: 1, roomVersion: 6, deviceId, deviceLabel: 'Phone', appVersion: '1.0.1005',
  createdAt: Date.now(), publishedAt: serverTimestamp(), hash, bytes: 1, chunkIds: [hash],
  counts: Object.fromEntries(tables.map(t => [t, 0])), ...extra });

test('owner creates immutable bounded chunks and deletes them', async () => {
  const db = env.authenticatedContext('alice').firestore();
  const ref = doc(db, 'users/alice/vaultChunks/' + hash);
  await assertSucceeds(setDoc(ref, chunk()));
  await assertSucceeds(getDoc(ref));
  await assertFails(setDoc(ref, chunk()));
  await assertSucceeds(deleteDoc(ref));
  await assertFails(setDoc(ref, chunk({ payload: 'x'.repeat(409601) })));
  await assertFails(setDoc(ref, chunk({ bytes: 307201 })));
  await assertFails(setDoc(ref, chunk({ hash: 'b'.repeat(64) })));
  await assertFails(setDoc(ref, chunk({ credential: 'secret' })));
});

test('backup manifest and device pointer publish atomically', async () => {
  const db = env.authenticatedContext('alice').firestore();
  const batch = writeBatch(db);
  batch.set(doc(db, 'users/alice/backups/' + backupId), backup());
  batch.set(doc(db, 'users/alice/devices/' + deviceId), { deviceLabel: 'Phone', appVersion: '1.0.1005',
    latestBackup: backupId, updatedAt: serverTimestamp(), schema: 1 });
  await assertSucceeds(batch.commit());
  await assertSucceeds(getDoc(doc(db, 'users/alice/backups/' + backupId)));
  await assertFails(setDoc(doc(db, 'users/alice/backups/' + backupId), backup()));
});

test('backup and device data remain private across every new collection', async () => {
  await env.withSecurityRulesDisabled(async ctx => {
    for (const [collection, id] of [['vaultChunks', hash], ['backups', backupId], ['devices', deviceId]]) {
      await setDoc(doc(ctx.firestore(), 'users/alice/' + collection + '/' + id), { schema: 1 });
    }
  });
  for (const ctx of [env.unauthenticatedContext(), env.authenticatedContext('mallory')]) {
    for (const [collection, id] of [['vaultChunks', hash], ['backups', backupId], ['devices', deviceId]]) {
      const ref = doc(ctx.firestore(), 'users/alice/' + collection + '/' + id);
      await assertFails(getDoc(ref));
      await assertFails(setDoc(ref, { schema: 1 }));
      await assertFails(deleteDoc(ref));
    }
  }
});

test('malformed manifests and dangling device pointers are rejected', async () => {
  const db = env.authenticatedContext('alice').firestore();
  const ref = doc(db, 'users/alice/backups/' + backupId);
  for (const extra of [{ bytes: 67108865 }, { chunkIds: [] }, { counts: { tracks: -1 } }, { roomVersion: 999 }, { isAdmin: true }]) {
    await assertFails(setDoc(ref, backup(extra)));
  }
  await assertFails(setDoc(doc(db, 'users/alice/devices/' + deviceId), {
    deviceLabel: 'Phone', appVersion: '1.0.1005', latestBackup: backupId, updatedAt: serverTimestamp(), schema: 1 }));
});

const liveRecord = (kind, value, extra = {}) => ({kind, value, revision: 1, deleted: false,
  deviceId, updatedAt: serverTimestamp(), schema: 1, ...extra});
test('live records are private and have validated identities and revisions', async () => {
  const db = env.authenticatedContext('alice').firestore();
  const setting = doc(db, 'users/alice/liveRecords/s_crossfadeMs');
  await assertSucceeds(setDoc(setting, liveRecord('setting', '6000')));
  await assertFails(setDoc(setting, liveRecord('setting', '7000')));
  await assertSucceeds(setDoc(setting, liveRecord('setting', '7000', {revision: 2})));
  await assertFails(setDoc(doc(db, 'users/alice/liveRecords/s_cloudSync'), liveRecord('setting', 'true')));
  await assertFails(setDoc(doc(db, 'users/alice/liveRecords/s_analytics'), liveRecord('setting', 'true')));
  await assertFails(setDoc(doc(db, 'users/alice/liveRecords/s_crossfadeMs'), liveRecord('history', '{}', {revision: 3})));
  for (const ctx of [env.unauthenticatedContext(), env.authenticatedContext('mallory')]) {
    await assertFails(getDoc(doc(ctx.firestore(), 'users/alice/liveRecords/s_crossfadeMs')));
    await assertFails(setDoc(doc(ctx.firestore(), 'users/alice/liveRecords/q_shared'), liveRecord('queue', '{}')));
  }
});
test('listening event content is immutable and tombstones cannot resurrect', async () => {
  const db = env.authenticatedContext('alice').firestore();
  const ref = doc(db, 'users/alice/liveRecords/h_' + hash);
  await assertSucceeds(setDoc(ref, liveRecord('history', '{"listenedMs":12345}')));
  await assertFails(setDoc(ref, liveRecord('history', '{"listenedMs":99999}', {revision: 2})));
  await assertSucceeds(setDoc(ref, liveRecord('history', '{"listenedMs":12345}', {revision: 2, deleted: true})));
  await assertFails(setDoc(ref, liveRecord('history', '{"listenedMs":12345}', {revision: 3})));
  await assertFails(setDoc(doc(db, 'users/alice/liveRecords/q_shared'), liveRecord('queue', 'x'.repeat(200001))));
});
