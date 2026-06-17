// The follows hose — kind 3 (contact list / social graph).
//
// Stores the *derived* nostr-beacon shape `{ pubkey, follows: [hex…],
// created_at, count }` (not the raw event): the in-degree query
// (`followerCount`) and `enrichCounts` both rely on the top-level `follows`
// array + `count`. As a side-effect it harvests relay URLs from the legacy
// relay map some clients still put in kind-3 `content`, seeding the `relays`
// directory (discovery only — it never overwrites health metrics).
import { verifySignature } from './event.js';
import { harvestRelays, ensureRelayDirectoryIndex } from './relays.js';
import { COLLECTIONS } from '../db.js';

const KIND = 3;
const HEX64 = /^[0-9a-f]{64}$/;

/** Validate a kind-3 event. Unlike kind 0, content is optional / free-form. */
export function verifyEvent(e) {
  if (!e || e.kind !== KIND) return false;
  return verifySignature(e);
}

/** Followed pubkeys from `p` tags — 64-hex only, lowercased, deduped. */
export function parseFollows(event) {
  const out = new Set();
  if (Array.isArray(event?.tags)) {
    for (const t of event.tags) {
      if (t?.[0] === 'p' && typeof t[1] === 'string') {
        const hex = t[1].toLowerCase();
        if (HEX64.test(hex)) out.add(hex);
      }
    }
  }
  return [...out];
}

/** Relay URLs from the legacy NIP-65-ish relay map in kind-3 content. */
export function relayUrlsFrom(event) {
  if (!event?.content) return [];
  let map;
  try { map = JSON.parse(event.content); } catch { return []; }
  if (!map || typeof map !== 'object') return [];
  return Object.keys(map);
}

export default {
  name: 'follows',
  kinds: [KIND],

  async ensureIndexes(db) {
    const ok = (e) => { if (e?.code !== 85 && e?.code !== 86) throw e; };
    const col = db.collection(COLLECTIONS[KIND]);
    await col.createIndex({ pubkey: 1 }).catch(ok);
    await col.createIndex({ follows: 1 }).catch(ok); // reverse lookup / in-degree
    await col.createIndex({ created_at: -1 }).catch(ok);
    await ensureRelayDirectoryIndex(db);
  },

  /** Verify, latest-wins upsert of the derived shape, then harvest relays. */
  async ingest(event, db) {
    if (!verifyEvent(event)) return false;
    const col = db.collection(COLLECTIONS[KIND]);
    const existing = await col.findOne({ pubkey: event.pubkey }, { projection: { created_at: 1 } });
    if (existing && existing.created_at >= event.created_at) return false;
    const follows = parseFollows(event);
    await col.replaceOne(
      { pubkey: event.pubkey },
      { pubkey: event.pubkey, follows, created_at: event.created_at, count: follows.length },
      { upsert: true },
    );
    await harvestRelays(db, relayUrlsFrom(event)); // discovery; best-effort
    return true;
  },
};
