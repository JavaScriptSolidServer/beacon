// planRelaySweep: categorization for the relay-directory data sweep.
import test from 'node:test';
import assert from 'node:assert/strict';
import { planRelaySweep } from '../src/hoses/relays.js';

const ids = (arr) => arr.map((d) => d._id).sort();

test('bad URLs are dropped', () => {
  const docs = [
    { _id: 1, relay: 'wss://relay.damus.io/' },
    { _id: 2, relay: 'ws://127.0.0.1/' },       // SSRF
    { _id: 3, relay: 'garbage' },                // malformed
    { _id: 4, relay: 'wss://nostr.wine/inbox' },
  ];
  const p = planRelaySweep(docs, {});
  assert.deepEqual(ids(p.bad), [2, 3]);
});

test('dedup keeps the richest of a canonical group', () => {
  const docs = [
    { _id: 1, relay: 'wss://nos.lol', checksTotal: 2 },     // canonicalizes to wss://nos.lol/
    { _id: 2, relay: 'wss://nos.lol/', checksTotal: 9 },    // richest -> keep
    { _id: 3, relay: 'wss://nos.lol/', checksTotal: 0 },
  ];
  const p = planRelaySweep(docs, {});
  assert.deepEqual(ids(p.dups), [1, 3]);   // two dropped
  assert.equal(p.kept, 1);
});

test('host-spam: trims path-variant flooding, keeps origin + richest few', () => {
  const docs = [
    { _id: 0, relay: 'wss://nostr.wine/', checksTotal: 1 },        // origin — always kept
    { _id: 1, relay: 'wss://nostr.wine/echo-zulu', checksTotal: 5 },
    { _id: 2, relay: 'wss://nostr.wine/flint-cipher', checksTotal: 4 },
    { _id: 3, relay: 'wss://nostr.wine/raven-warden', checksTotal: 3 },
    { _id: 4, relay: 'wss://nostr.wine/juliet-jade', checksTotal: 2 },
  ];
  const p = planRelaySweep(docs, { maxPerHost: 3 });
  assert.equal(p.kept, 3);
  // origin (0) kept; then richest paths (1,2); spam = the rest (3,4)
  assert.deepEqual(ids(p.hostSpam), [3, 4]);
});

test('a host under the cap is untouched', () => {
  const docs = [
    { _id: 1, relay: 'wss://relay.example.com/inbox' },
    { _id: 2, relay: 'wss://relay.example.com/outbox' },
  ];
  const p = planRelaySweep(docs, { maxPerHost: 3 });
  assert.deepEqual(p.hostSpam, []);
  assert.equal(p.kept, 2);
});

test('renorm flags survivors whose stored URL is not canonical', () => {
  const docs = [{ _id: 1, relay: 'wss://nos.lol' }]; // -> wss://nos.lol/
  const p = planRelaySweep(docs, {});
  assert.equal(p.renames.length, 1);
  assert.equal(p.renames[0].canonical, 'wss://nos.lol/');
});

test('realOnly: keep only bare origins online at least once', () => {
  const docs = [
    { _id: 1, relay: 'wss://good.example.com/', checksOnline: 3 },     // bare + online -> keep
    { _id: 2, relay: 'wss://dead.example.com/', checksOnline: 0 },     // bare but never online -> notReal
    { _id: 3, relay: 'wss://path.example.com/echo-zulu', checksOnline: 5 }, // online but has path -> notReal
    { _id: 4, relay: 'wss://fresh.example.com/' },                     // no checksOnline -> notReal
  ];
  const p = planRelaySweep(docs, { realOnly: true });
  assert.equal(p.kept, 1);
  assert.deepEqual(ids(p.notReal), [2, 3, 4]);
});

test('stale prune by age (only when staleDays set)', () => {
  const now = 1_000_000_000_000;
  const docs = [
    { _id: 1, relay: 'wss://a.example.com/', lastChecked: new Date(now - 2 * 864e5).toISOString() }, // 2d old
    { _id: 2, relay: 'wss://b.example.com/', lastChecked: new Date(now - 10 * 864e5).toISOString() }, // 10d old
  ];
  assert.deepEqual(ids(planRelaySweep(docs, { staleDays: 7, now }).stale), [2]);
  assert.deepEqual(planRelaySweep(docs, { now }).stale, []); // no staleDays -> none
});
