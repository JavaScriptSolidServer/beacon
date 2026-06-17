// CLI flag parsing for the indexer. parseArgs produces an env-overlay that
// runIndexer merges over process.env (flags win, env is the fallback).
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, planIngest } from '../src/indexer.js';

const profiles = { name: 'profiles', kinds: [0] };
const follows = { name: 'follows', kinds: [3] };
const ALL = [profiles, follows];

test('no flags -> empty overlay', () => {
  assert.deepEqual(parseArgs([]), {});
});

test('--hoses with a space-separated value', () => {
  assert.deepEqual(parseArgs(['--hoses', 'profiles,follows']), { HOSES: 'profiles,follows' });
});

test('--hoses=value form', () => {
  assert.deepEqual(parseArgs(['--hoses=profiles']), { HOSES: 'profiles' });
});

test('--hoses with no value -> empty string (planIngest treats as default)', () => {
  assert.deepEqual(parseArgs(['--hoses']), { HOSES: '' });
  assert.deepEqual(parseArgs(['--hoses', '--no-legacy']), { HOSES: '', INDEX_LEGACY_KINDS: '0' });
});

test('--no-legacy and --legacy map to INDEX_LEGACY_KINDS', () => {
  assert.deepEqual(parseArgs(['--no-legacy']), { INDEX_LEGACY_KINDS: '0' });
  assert.deepEqual(parseArgs(['--legacy']), { INDEX_LEGACY_KINDS: '1' });
});

test('--help / -h set help', () => {
  assert.equal(parseArgs(['--help']).help, true);
  assert.equal(parseArgs(['-h']).help, true);
});

test('flags compose', () => {
  assert.deepEqual(parseArgs(['--hoses', 'profiles', '--no-legacy']),
    { HOSES: 'profiles', INDEX_LEGACY_KINDS: '0' });
});

test('flags override env when merged (the runIndexer contract)', () => {
  const env = { HOSES: 'profiles,follows', INDEX_LEGACY_KINDS: '1' };
  const merged = { ...env, ...parseArgs(['--hoses', 'profiles', '--no-legacy']) };
  const p = planIngest(ALL, merged, []);
  assert.deepEqual(p.hoses.map((h) => h.name), ['profiles']); // flag won over env
  assert.equal(p.legacy, false);
  assert.deepEqual(p.kinds, [0]);
});
