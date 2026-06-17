// The relay-lists hose — kind 10002 (NIP-65 relay list metadata).
//
// Stores the raw event latest-wins in `relay_lists` (the shape diddoc reads to
// build the DID document's `service`/`Relay` entries). As a side-effect it
// harvests the `r`-tag URLs into the `relays` directory — the canonical source
// of relay URLs, which the relay-health prober (phase 4) checks.
import { verifySignature } from './event.js';
import { harvestRelays, ensureRelayDirectoryIndex } from './relays.js';
import { COLLECTIONS } from '../db.js';

const KIND = 10002;

/** Validate a kind-10002 event. Content is free-form; relays live in `r` tags. */
export function verifyEvent(e) {
  if (!e || e.kind !== KIND) return false;
  return verifySignature(e);
}

/** Relay URLs from `r` tags (NIP-65). */
export function relayUrlsFrom(event) {
  if (!Array.isArray(event?.tags)) return [];
  return event.tags.filter((t) => t?.[0] === 'r' && typeof t[1] === 'string').map((t) => t[1]);
}

export default {
  name: 'relaylists',
  kinds: [KIND],

  async ensureIndexes(db) {
    const ok = (e) => { if (e?.code !== 85 && e?.code !== 86) throw e; };
    const col = db.collection(COLLECTIONS[KIND]);
    await col.createIndex({ pubkey: 1 }).catch(ok);
    await col.createIndex({ created_at: -1 }).catch(ok);
    await ensureRelayDirectoryIndex(db);
  },

  /** Verify, latest-wins upsert of the raw event, then harvest its relays. */
  async ingest(event, db) {
    if (!verifyEvent(event)) return false;
    const col = db.collection(COLLECTIONS[KIND]);
    const existing = await col.findOne({ pubkey: event.pubkey }, { projection: { created_at: 1 } });
    if (existing && existing.created_at >= event.created_at) return false;
    await col.updateOne({ pubkey: event.pubkey }, { $set: { ...event } }, { upsert: true });
    await harvestRelays(db, relayUrlsFrom(event)); // discovery; best-effort
    return true;
  },
};
