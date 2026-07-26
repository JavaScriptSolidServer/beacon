// Unit tests for the conformant did:nostr DID-document builder (no Mongo needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDidDocument } from '../src/diddoc.js';

const PK = '124c0fa99407182ece5a24fad9b7f6674902fc422843d3128d38a0afbee0fdd2';

test('minimal doc is spec-shaped (did/v1 + cid/v1, Multikey, publicKeyMultibase)', () => {
  const d = buildDidDocument(PK);
  assert.deepEqual(d['@context'], ['https://www.w3.org/ns/did/v1', 'https://www.w3.org/ns/cid/v1', 'https://w3id.org/nostr/context']);
  assert.equal(d.id, `did:nostr:${PK}`);
  assert.equal(d.type, 'DIDNostr');
  assert.equal(d.verificationMethod[0].type, 'Multikey');
  assert.equal(d.verificationMethod[0].publicKeyMultibase, `fe70102${PK}`);
  assert.equal(d.verificationMethod[0].id, `did:nostr:${PK}#key1`);
  assert.deepEqual(d.authentication, ['#key1']);
  assert.deepEqual(d.assertionMethod, ['#key1']);
  assert.equal(d.modified, undefined); // no signed parts composed -> no change time
});

test('enhanced: profile (kind 0), follows (kind 3), service (kind 10002), modified', () => {
  const follow = 'a'.repeat(64);
  const d = buildDidDocument(PK, {
    profile: { content: JSON.stringify({ name: 'Alice', nip05: 'alice@example.com' }), created_at: 100 },
    follows: { tags: [['p', follow], ['e', 'ignored']], created_at: 250 },
    relays: { tags: [['r', 'wss://relay.example/']], created_at: 200 },
  });
  assert.equal(d.profile.name, 'Alice');
  assert.equal(d.profile.nip05, 'alice@example.com');
  assert.equal(d.profile.created_at, 100);
  assert.equal(d.profile.timestamp, undefined);
  assert.deepEqual(d.follows, [`did:nostr:${follow}`]);
  assert.equal(d.service[0].type, 'Relay');
  assert.equal(d.service[0].serviceEndpoint, 'wss://relay.example/');
  // modified = max(created_at) over composed parts (100, 250, 200), ISO-8601 UTC
  assert.equal(d.modified, '1970-01-01T00:04:10Z');
});

test('follows: derived nostr-beacon shape ({follows:[hex,…]}) also resolves', () => {
  const a = 'a'.repeat(64), b = 'b'.repeat(64);
  const d = buildDidDocument(PK, { follows: { follows: [a, b], count: 2 } });
  assert.deepEqual(d.follows, [`did:nostr:${a}`, `did:nostr:${b}`]);
});

test('follows is bounded; the full signed list stays in the kind-3 event', () => {
  const many = Array.from({ length: 600 }, (_, i) => i.toString(16).padStart(64, '0'));
  const d = buildDidDocument(PK, { follows: { follows: many } });
  assert.equal(d.follows.length, 500);
});

test('alsoKnownAs-only kind-0 still contributes its created_at to modified', () => {
  const d = buildDidDocument(PK, {
    profile: { content: JSON.stringify({ alsoKnownAs: ['https://x.example/#me'] }), created_at: 300 },
  });
  assert.equal(d.profile, undefined); // no profile fields composed
  assert.deepEqual(d.alsoKnownAs, ['https://x.example/#me']);
  assert.equal(d.modified, '1970-01-01T00:05:00Z'); // kind-0 created_at (300) still counts
});

test('out-of-range created_at does not throw and is omitted (no modified)', () => {
  const d = buildDidDocument(PK, {
    profile: { content: JSON.stringify({ name: 'X' }), created_at: 1e308 },
  });
  assert.equal(d.profile.name, 'X');
  assert.equal(d.profile.created_at, undefined); // not a safe integer -> omitted
  assert.equal(d.modified, undefined);           // no valid stamp -> no modified
});

test('rejects a non-hex (e.g. npub) identifier', () => {
  assert.equal(buildDidDocument('npub1xxx'), null);
  assert.equal(buildDidDocument(''), null);
});
