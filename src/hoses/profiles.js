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
import { verifySignature } from './event.js';
import { COLLECTIONS } from '../db.js';

const KIND = 0;

/**
 * Validate a raw kind-0 event: right kind, JSON-parseable content (empty is
 * allowed, treated as {}), plus the shared structural + schnorr-signature
 * check. Rejects forged or tampered profiles so a relay can't inject one.
 */
export function verifyEvent(e) {
  if (!e || e.kind !== KIND) return false;
  if (e.content) { try { JSON.parse(e.content); } catch { return false; } }
  return verifySignature(e);
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
