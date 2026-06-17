// Relay-lists hose: signature verification + r-tag extraction.
import test from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js';
import { verifyEvent, relayUrlsFrom } from '../src/hoses/relaylists.js';

const enc = new TextEncoder();
const PRIV = hexToBytes('0000000000000000000000000000000000000000000000000000000000000004');
const PUBKEY = bytesToHex(schnorr.getPublicKey(PRIV));

function signed({ tags = [], content = '', created_at = 1000, kind = 10002 } = {}) {
  const base = { pubkey: PUBKEY, created_at, kind, tags, content };
  const id = bytesToHex(sha256(enc.encode(JSON.stringify([0, base.pubkey, base.created_at, base.kind, base.tags, base.content]))));
  const sig = bytesToHex(schnorr.sign(hexToBytes(id), PRIV));
  return { ...base, id, sig };
}

test('accepts a validly-signed kind-10002 event', () => {
  assert.equal(verifyEvent(signed({ tags: [['r', 'wss://relay.example.com']] })), true);
});

test('rejects the wrong kind', () => {
  assert.equal(verifyEvent(signed({ kind: 3 })), false);
});

test('rejects a tampered event', () => {
  const e = signed({ tags: [['r', 'wss://relay.example.com']] });
  e.tags = [['r', 'wss://evil.example.com']]; // changed after signing
  assert.equal(verifyEvent(e), false);
});

test('rejects malformed input without throwing', () => {
  for (const bad of [null, undefined, {}, 42, 'x']) assert.equal(verifyEvent(bad), false);
});

test('relayUrlsFrom: pulls r-tag URLs, ignores other tags', () => {
  const e = signed({ tags: [
    ['r', 'wss://relay.example.com'],
    ['r', 'wss://other.example.com/', 'read'], // marker is fine
    ['L', 'pink.momostr'],                     // non-r tag ignored
    ['r'],                                      // malformed skipped
  ] });
  assert.deepEqual(relayUrlsFrom(e), ['wss://relay.example.com', 'wss://other.example.com/']);
});

test('relayUrlsFrom: no tags -> empty', () => {
  assert.deepEqual(relayUrlsFrom(signed()), []);
});
