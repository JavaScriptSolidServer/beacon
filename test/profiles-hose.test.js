// Profiles hose: validation + signature verification.
// We sign real kind-0 events with a known key, then assert accept/reject.
import test from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js';
import { verifyEvent } from '../src/hoses/profiles.js';

const enc = new TextEncoder();
const PRIV = hexToBytes('0000000000000000000000000000000000000000000000000000000000000001');
const PUBKEY = bytesToHex(schnorr.getPublicKey(PRIV));

// Build a properly-signed kind-0 event.
function signed({ content = '{"name":"alice"}', created_at = 1000, kind = 0 } = {}) {
  const base = { pubkey: PUBKEY, created_at, kind, tags: [], content };
  const id = bytesToHex(sha256(enc.encode(JSON.stringify([0, base.pubkey, base.created_at, base.kind, base.tags, base.content]))));
  const sig = bytesToHex(schnorr.sign(hexToBytes(id), PRIV));
  return { ...base, id, sig };
}

test('accepts a validly-signed kind-0 event', () => {
  assert.equal(verifyEvent(signed()), true);
});

test('accepts empty content (treated as {})', () => {
  assert.equal(verifyEvent(signed({ content: '' })), true);
});

test('rejects tampered content (sig no longer matches)', () => {
  const e = signed();
  e.content = '{"name":"mallory"}';
  assert.equal(verifyEvent(e), false);
});

test('rejects a tampered id', () => {
  const e = signed();
  e.id = 'ff' + e.id.slice(2);
  assert.equal(verifyEvent(e), false);
});

test('rejects a forged/garbage signature', () => {
  const e = signed();
  e.sig = 'f'.repeat(128);
  assert.equal(verifyEvent(e), false);
});

test('rejects non-hex pubkey', () => {
  const e = signed();
  e.pubkey = 'npub1xxx';
  assert.equal(verifyEvent(e), false);
});

test('rejects the wrong kind', () => {
  assert.equal(verifyEvent(signed({ kind: 3 })), false);
});

test('rejects non-JSON content', () => {
  // Re-sign so the sig is valid but content is not JSON — must still reject.
  const e = signed({ content: 'not json{' });
  assert.equal(verifyEvent(e), false);
});

test('rejects malformed input without throwing', () => {
  for (const bad of [null, undefined, {}, { kind: 0 }, 42, 'x']) {
    assert.equal(verifyEvent(bad), false);
  }
});
