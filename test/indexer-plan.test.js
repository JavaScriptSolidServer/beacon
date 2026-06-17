// The HOSES / INDEX_LEGACY_KINDS switch: planIngest selects which hoses run
// and which kinds get subscribed. Pure function — test with fake hoses and an
// explicit legacy-kind set (so these stay stable as real hoses are added).
import test from 'node:test';
import assert from 'node:assert/strict';
import { planIngest } from '../src/indexer.js';

const profiles = { name: 'profiles', kinds: [0] };
const follows = { name: 'follows', kinds: [3] };
const ALL = [profiles, follows];
const LEGACY = [10002]; // a kind with no hose yet, for these scenarios

const sorted = (a) => [...a].sort((x, y) => x - y);

test('default (no env): all registered hoses on + legacy kinds', () => {
  const p = planIngest(ALL, {}, LEGACY);
  assert.deepEqual(p.hoses.map((h) => h.name), ['profiles', 'follows']);
  assert.equal(p.legacy, true);
  assert.deepEqual(sorted(p.kinds), [0, 3, 10002]);
  assert.deepEqual(p.unknown, []);
});

test('empty HOSES string falls back to the default (all on)', () => {
  assert.deepEqual(sorted(planIngest(ALL, { HOSES: '' }, LEGACY).kinds), [0, 3, 10002]);
});

test('HOSES selects a subset', () => {
  const p = planIngest(ALL, { HOSES: 'profiles' }, LEGACY);
  assert.deepEqual(p.hoses.map((h) => h.name), ['profiles']);
  assert.deepEqual(sorted(p.kinds), [0, 10002]); // profiles + legacy
});

test('INDEX_LEGACY_KINDS=0 → only enabled hoses\' kinds, no legacy', () => {
  const p = planIngest(ALL, { HOSES: 'profiles', INDEX_LEGACY_KINDS: '0' }, LEGACY);
  assert.equal(p.legacy, false);
  assert.deepEqual(p.kinds, [0]);
});

test('INDEX_LEGACY_KINDS=false is also off', () => {
  assert.equal(planIngest(ALL, { INDEX_LEGACY_KINDS: 'false' }, LEGACY).legacy, false);
});

test('unknown hose names are reported and ignored', () => {
  const p = planIngest(ALL, { HOSES: 'profiles,nope' }, LEGACY);
  assert.deepEqual(p.hoses.map((h) => h.name), ['profiles']);
  assert.deepEqual(p.unknown, ['nope']);
});

test('a hose that owns a legacy kind removes it from the legacy set', () => {
  // follows owns kind 3 — if 3 were also "legacy" it must not double-subscribe.
  const p = planIngest(ALL, {}, [3, 10002]);
  assert.deepEqual(p.legacyKinds, [10002]);
  assert.deepEqual(sorted(p.kinds), [0, 3, 10002]);
});

test('no legacy kinds (the real phase-3 state): just the hose kinds', () => {
  const p = planIngest(ALL, {}, []);
  assert.deepEqual(p.legacyKinds, []);
  assert.deepEqual(sorted(p.kinds), [0, 3]);
});
