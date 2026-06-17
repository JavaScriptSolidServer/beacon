// The profiles hose — first concrete "hose" on the firehose indexer.
//
// A hose is a small, self-contained ingest module: it declares the event
// `kinds` it wants, ensures its own Mongo indexes, and ingests one raw event
// at a time. The indexer subscribes to the union of all hoses' kinds and
// dispatches each event to the matching hose. Later phases add sibling hoses
// (follows, relay lists, relay health) without touching the indexer's core.
//
// This hose handles kind 0 (profile metadata). Unlike a blind upsert, it
// verifies each event's schnorr signature before trusting it — beacon is an
// identity/SSO substrate, so a malicious relay must not be able to inject a
// forged did:nostr profile.
import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js';
import { COLLECTIONS } from '../db.js';

const KIND = 0;
const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;
const enc = new TextEncoder();

// NIP-01 event id: sha256 of the canonical serialization
// [0, pubkey, created_at, kind, tags, content].
function eventId(e) {
  const serial = JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags || [], e.content ?? '']);
  return bytesToHex(sha256(enc.encode(serial)));
}

/**
 * Structural + cryptographic validation of a raw kind-0 event.
 * Rejects wrong kind, malformed fields, non-JSON content, a tampered `id`,
 * and any event whose schnorr signature doesn't verify against its pubkey.
 */
export function verifyEvent(e) {
  if (!e || e.kind !== KIND) return false;
  if (typeof e.pubkey !== 'string' || !HEX64.test(e.pubkey)) return false;
  if (!Number.isFinite(e.created_at)) return false;
  if (typeof e.sig !== 'string' || !HEX128.test(e.sig)) return false;
  // kind-0 content is a JSON object; empty string is allowed (treated as {}).
  if (e.content) { try { JSON.parse(e.content); } catch { return false; } }
  const id = eventId(e);
  if (e.id && e.id !== id) return false; // claimed id must match the content
  try { return schnorr.verify(hexToBytes(e.sig), hexToBytes(id), hexToBytes(e.pubkey)); }
  catch { return false; }
}

export default {
  name: 'profiles',
  kinds: [KIND],

  // Own the collection's indexes so a fresh deploy is fully functional:
  // pubkey (lookup/dedupe), created_at (recency), and the text index that
  // /api/search relies on. Tolerate a pre-existing index spec (codes 85/86).
  async ensureIndexes(db) {
    const col = db.collection(COLLECTIONS[KIND]);
    const ok = (e) => { if (e?.code !== 85 && e?.code !== 86) throw e; };
    await col.createIndex({ pubkey: 1 }).catch(ok);
    await col.createIndex({ created_at: -1 }).catch(ok);
    await col.createIndex({ content: 'text' }, { name: 'content_text' }).catch(ok);
  },

  /** Verify, then latest-wins upsert of the raw event. Returns true if stored. */
  async ingest(event, db) {
    if (!verifyEvent(event)) return false;
    const col = db.collection(COLLECTIONS[KIND]);
    const existing = await col.findOne({ pubkey: event.pubkey }, { projection: { created_at: 1 } });
    if (existing && existing.created_at >= event.created_at) return false;
    await col.updateOne({ pubkey: event.pubkey }, { $set: { ...event } }, { upsert: true });
    return true;
  },
};
