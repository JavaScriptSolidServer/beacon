// The HOSES / INDEX_LEGACY_KINDS switch: planIngest selects which hoses run
// and which kinds get subscribed. Pure function — test with fake hoses.
import test from 'node:test';
import assert from 'node:assert/strict';
import { planIngest } from '../src/indexer.js';

const profiles = { name: 'profiles', kinds: [0] };
const follows = { name: 'follows', kinds: [3] };
const ONE = [profiles];          // mirrors today's registry
const TWO = [profiles, follows]; // a future phase

const sorted = (a) => [...a].sort((x, y) => x - y);

test('default (no env): all registered hoses on + legacy kinds', () => {
  const p = planIngest(ONE, {});
  assert.deepEqual(p.hoses.map((h) => h.name), ['profiles']);
  assert.equal(p.legacy, true);
  assert.deepEqual(sorted(p.kinds), [0, 3, 10002]);
  assert.deepEqual(p.unknown, []);
});

test('empty HOSES string falls back to the default (all on)', () => {
  assert.deepEqual(sorted(planIngest(ONE, { HOSES: '' }).kinds), [0, 3, 10002]);
});

test('INDEX_LEGACY_KINDS=0 → only enabled hoses\' kinds, no legacy', () => {
  const p = planIngest(ONE, { HOSES: 'profiles', INDEX_LEGACY_KINDS: '0' });
  assert.equal(p.legacy, false);
  assert.deepEqual(p.kinds, [0]);
});

test('INDEX_LEGACY_KINDS=false is also off', () => {
  assert.equal(planIngest(ONE, { INDEX_LEGACY_KINDS: 'false' }).legacy, false);
});

test('unknown hose names are reported and ignored', () => {
  const p = planIngest(ONE, { HOSES: 'profiles,nope' });
  assert.deepEqual(p.hoses.map((h) => h.name), ['profiles']);
  assert.deepEqual(p.unknown, ['nope']);
});

test('selecting only an unknown hose leaves no hose kinds (legacy still applies)', () => {
  const p = planIngest(ONE, { HOSES: 'nope' });
  assert.deepEqual(p.hoses, []);
  assert.deepEqual(sorted(p.kinds), [3, 10002]); // legacy fallback only
});

test('a hose that owns a legacy kind removes it from the legacy set (no double-subscribe)', () => {
  const p = planIngest(TWO, {}); // follows owns kind 3
  assert.deepEqual(p.hoses.map((h) => h.name), ['profiles', 'follows']);
  assert.deepEqual(p.legacyKinds, [10002]); // 3 now owned by the follows hose
  assert.deepEqual(sorted(p.kinds), [0, 3, 10002]);
});

test('single-hose deploy: HOSES=follows + no legacy → just kind 3', () => {
  const p = planIngest(TWO, { HOSES: 'follows', INDEX_LEGACY_KINDS: '0' });
  assert.deepEqual(p.kinds, [3]);
});
