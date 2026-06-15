// Unit tests for the Mongo schema/behavior (run against a throwaway db).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.MONGO_DB = process.env.TEST_DB || 'beacon_test'; // set before importing db.js
const { connect, close, upsertEvent, getProfile, getFollows, getRelays, COLLECTIONS } =
  await import('../src/db.js');

const ev = (kind, pubkey, created_at, extra = {}) =>
  ({ id: `id-${created_at}`, pubkey, created_at, kind, tags: [], content: '', sig: 'sig', ...extra });

const wipe = async () => {
  const db = await connect();
  for (const c of new Set(Object.values(COLLECTIONS))) await db.collection(c).deleteMany({});
};

before(wipe);
after(async () => { await wipe(); await close(); });

test('routes each kind to its collection', async () => {
  await upsertEvent(ev(0, 'pk0', 100));
  await upsertEvent(ev(3, 'pk3', 100));
  await upsertEvent(ev(10002, 'pkr', 100));
  assert.equal((await getProfile('pk0')).kind, 0);
  assert.equal((await getFollows('pk3')).kind, 3);
  assert.equal((await getRelays('pkr')).kind, 10002);
});

test('latest-wins: newer overwrites, older is ignored', async () => {
  await upsertEvent(ev(0, 'pk', 100, { content: 'old' }));
  assert.equal(await upsertEvent(ev(0, 'pk', 200, { content: 'new' })), true);
  assert.equal((await getProfile('pk')).content, 'new');
  assert.equal(await upsertEvent(ev(0, 'pk', 150, { content: 'stale' })), false); // older than 200
  assert.equal((await getProfile('pk')).content, 'new'); // unchanged
});

test('stores the raw event (parity shape), keyed by pubkey', async () => {
  await upsertEvent(ev(0, 'pkraw', 100, { content: '{"name":"x"}' }));
  const doc = await getProfile('pkraw');
  for (const k of ['id', 'pubkey', 'created_at', 'kind', 'tags', 'content', 'sig']) {
    assert.ok(k in doc, `raw event has ${k}`);
  }
});

test('ignores unknown kinds', async () => {
  assert.equal(await upsertEvent(ev(1, 'pk1', 100)), false);
  assert.equal(await getProfile('pk1'), null);
});
