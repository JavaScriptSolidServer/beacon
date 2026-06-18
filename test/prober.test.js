// Relay-health prober: pure helpers (config/flags, NIP-11 flags, URL mapping).
// The network/Mongo paths (checkRelay/fetchNip11/sweepOnce) are exercised by a
// manual smoke run, not here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js';
import { parseArgs, proberConfig, relayInfoUrl, nip11Flags, proberRelays, DEFAULT_PROBE_RELAYS, selectTargets, buildTestEvent, reasonCat } from '../src/prober.js';
import { verifySignature } from '../src/hoses/event.js';

test('parseArgs: flags', () => {
  assert.deepEqual(parseArgs(['--once']), { once: true });
  assert.deepEqual(parseArgs(['--concurrency', '50']), { concurrency: 50 });
  assert.deepEqual(parseArgs(['--timeout', '3000', '--interval', '600000']), { timeout: 3000, interval: 600000 });
  assert.equal(parseArgs(['--help']).help, true);
  assert.equal(parseArgs(['-h']).help, true);
  assert.deepEqual(parseArgs([]), {});
});

test('parseArgs: non-numeric value is ignored (not consumed as flag value)', () => {
  assert.deepEqual(parseArgs(['--concurrency', 'abc']), {});
});

test('proberConfig: defaults (daily)', () => {
  const c = proberConfig({}, []);
  assert.equal(c.interval, 86_400_000);
  assert.equal(c.concurrency, 25);
  assert.equal(c.timeout, 7_000);
  assert.equal(c.once, false);
});

test('proberRelays: default is the built-in allowlist (screened)', () => {
  const r = proberRelays({});
  assert.equal(r.length, DEFAULT_PROBE_RELAYS.length);
  assert.ok(r.every((u) => u.startsWith('wss://')));
});

test('proberRelays: PROBE_RELAYS overrides; junk/SSRF entries dropped', () => {
  const r = proberRelays({ PROBE_RELAYS: 'wss://relay.example.com, ws://127.0.0.1/, garbage, wss://nos.lol' });
  assert.deepEqual(r, ['wss://relay.example.com/', 'wss://nos.lol/']); // loopback + junk screened out
});

test('selectTargets: allowlist + verified candidates, screened, deduped, capped', () => {
  const allow = ['wss://relay.damus.io/', 'wss://nos.lol/'];
  const cands = ['wss://verified-a.example.com/', 'ws://127.0.0.1/', 'wss://relay.damus.io/', 'wss://verified-b.example.com/'];
  const out = selectTargets(allow, cands, 1000);
  assert.deepEqual(out, ['wss://relay.damus.io/', 'wss://nos.lol/', 'wss://verified-a.example.com/', 'wss://verified-b.example.com/']);
  // SSRF candidate dropped; damus de-duped against allowlist
});

test('selectTargets: respects the cap', () => {
  const allow = ['wss://a.example.com/'];
  const cands = ['wss://b.example.com/', 'wss://c.example.com/', 'wss://d.example.com/'];
  assert.deepEqual(selectTargets(allow, cands, 2), ['wss://a.example.com/', 'wss://b.example.com/']);
});

test('proberConfig: env applies, non-positive falls back to default', () => {
  const c = proberConfig({ PROBE_CONCURRENCY: '40', PROBE_TIMEOUT: '0', RUN_ONCE: '1' }, []);
  assert.equal(c.concurrency, 40);
  assert.equal(c.timeout, 7_000); // 0 is rejected -> default
  assert.equal(c.once, true);
});

test('proberConfig: flags override env', () => {
  const c = proberConfig({ PROBE_CONCURRENCY: '40', RUN_ONCE: '1' }, ['--concurrency', '10']);
  assert.equal(c.concurrency, 10); // flag beat env
  assert.equal(c.once, true);      // env still applies where no flag
});

test('relayInfoUrl: ws(s) -> http(s), else null', () => {
  assert.equal(relayInfoUrl('wss://relay.example.com'), 'https://relay.example.com/');
  assert.equal(relayInfoUrl('wss://relay.example.com/inbox'), 'https://relay.example.com/inbox');
  assert.equal(relayInfoUrl('ws://relay.example.com'), 'http://relay.example.com/');
  assert.equal(relayInfoUrl('https://not-a-relay.com'), null);
  assert.equal(relayInfoUrl('garbage'), null);
});

test('nip11Flags: reads auth/payment/pow/restricted, defaults false', () => {
  assert.deepEqual(nip11Flags({ limitation: { auth_required: true, min_pow_difficulty: 28, restricted_writes: true } }),
    { requiresAuth: true, requiresPayment: false, requiresPow: true, restrictedWrites: true });
  assert.deepEqual(nip11Flags({ limitation: { min_pow_difficulty: 0 } }),
    { requiresAuth: false, requiresPayment: false, requiresPow: false, restrictedWrites: false });
  assert.deepEqual(nip11Flags(null),
    { requiresAuth: false, requiresPayment: false, requiresPow: false, restrictedWrites: false });
});

test('reasonCat: parses NIP-01 OK-message prefixes', () => {
  assert.equal(reasonCat('pow: 28 bits needed'), 'pow');
  assert.equal(reasonCat('auth-required: please AUTH'), 'auth-required');
  assert.equal(reasonCat('restricted: not in WoT'), 'restricted');
  assert.equal(reasonCat('blocked: spam'), 'blocked');
  assert.equal(reasonCat('rate-limited: slow down'), 'rate-limited');
  assert.equal(reasonCat(''), '');
  assert.equal(reasonCat('some freeform rejection'), 'rejected');
});

test('buildTestEvent: a valid signed ephemeral event', () => {
  const priv = '0000000000000000000000000000000000000000000000000000000000000005';
  const e = buildTestEvent(priv, 1_700_000_000_000);
  assert.equal(e.kind, 20000);                 // NIP-16 ephemeral
  assert.equal(e.pubkey, bytesToHex(schnorr.getPublicKey(hexToBytes(priv))));
  assert.equal(verifySignature(e), true);      // properly signed
});
