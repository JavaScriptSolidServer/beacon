// Follows hose: signature verification + p-tag derivation + relay harvesting.
import test from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js';
import { verifyEvent, parseFollows, relayUrlsFrom } from '../src/hoses/follows.js';
import { canonicalizeRelayUrl } from '../src/hoses/relays.js';

const enc = new TextEncoder();
const PRIV = hexToBytes('0000000000000000000000000000000000000000000000000000000000000003');
const PUBKEY = bytesToHex(schnorr.getPublicKey(PRIV));
const PK = (n) => String(n).padStart(64, '0'); // a fake 64-hex pubkey

function signed({ tags = [], content = '', created_at = 1000, kind = 3 } = {}) {
  const base = { pubkey: PUBKEY, created_at, kind, tags, content };
  const id = bytesToHex(sha256(enc.encode(JSON.stringify([0, base.pubkey, base.created_at, base.kind, base.tags, base.content]))));
  const sig = bytesToHex(schnorr.sign(hexToBytes(id), PRIV));
  return { ...base, id, sig };
}

test('accepts a validly-signed kind-3 event (empty content ok)', () => {
  assert.equal(verifyEvent(signed()), true);
});

test('rejects the wrong kind', () => {
  assert.equal(verifyEvent(signed({ kind: 0 })), false);
});

test('rejects a tampered event', () => {
  const e = signed({ tags: [['p', PK(1)]] });
  e.tags = [['p', PK(2)]]; // change after signing
  assert.equal(verifyEvent(e), false);
});

test('rejects malformed input without throwing', () => {
  for (const bad of [null, undefined, {}, 42, 'x']) assert.equal(verifyEvent(bad), false);
});

test('parseFollows: p tags only, 64-hex, lowercased, deduped', () => {
  const e = signed({ tags: [
    ['p', PK('a').toUpperCase()],   // uppercased -> lowercased
    ['p', PK('a')],                 // duplicate -> deduped
    ['p', PK('b')],
    ['e', PK('c')],                 // non-p tag -> ignored
    ['p', 'not-hex'],               // invalid -> dropped
    ['p'],                          // malformed -> skipped
  ] });
  assert.deepEqual(parseFollows(e), [PK('a'), PK('b')]);
});

test('parseFollows: no tags -> empty', () => {
  assert.deepEqual(parseFollows(signed()), []);
});

test('canonicalizeRelayUrl: trailing slash on origins, path preserved, junk dropped', () => {
  assert.equal(canonicalizeRelayUrl('wss://relay.example.com'), 'wss://relay.example.com/');
  assert.equal(canonicalizeRelayUrl('wss://relay.example.com/'), 'wss://relay.example.com/');
  assert.equal(canonicalizeRelayUrl('wss://relay.example.com/inbox'), 'wss://relay.example.com/inbox');
  assert.equal(canonicalizeRelayUrl('https://not-a-relay.com'), null);
  assert.equal(canonicalizeRelayUrl('garbage'), null);
});

test('relayUrlsFrom: returns the raw relay-map keys (canon/dedup is harvestRelays\' job)', () => {
  const content = JSON.stringify({
    'wss://relay.example.com': { read: true, write: true },
    'wss://other.example.com/inbox': { read: true, write: true },
  });
  assert.deepEqual(relayUrlsFrom(signed({ content })),
    ['wss://relay.example.com', 'wss://other.example.com/inbox']);
});

test('relayUrlsFrom: empty / non-JSON content -> empty', () => {
  assert.deepEqual(relayUrlsFrom(signed({ content: '' })), []);
  assert.deepEqual(relayUrlsFrom(signed({ content: 'not json' })), []);
});
