// MongoDB layer for the beacon.
//
// Schema matches nostr-beacon (for regression): each collection stores the
// RAW Nostr event, keyed by `pubkey`, latest-wins by `created_at`.
//   kind 0     -> profiles      (collection: beacon)
//   kind 3     -> social graph  (collection: follows)
//   kind 10002 -> relay lists   (collection: relay_lists)
import { MongoClient } from 'mongodb';
import 'dotenv/config';

const uri = process.env.MONGODB_URI || process.env.MONGO_URL || 'mongodb://localhost:27017';
const dbName = process.env.MONGO_DB || process.env.DB_NAME || 'nostr';

// Collection names default to the live nostr-beacon values so the same Mongo
// can be read/written interchangeably for regression.
export const COLLECTIONS = {
  0: process.env.MONGO_COLLECTION || 'beacon',
  3: process.env.MONGO_FOLLOWS_COLLECTION || 'follows',
  10002: process.env.MONGO_RELAYS_COLLECTION || 'relay_lists',
};

// Firehose relay-health directory (one doc per relay URL, written by the
// nostr-beacon monitor). Distinct from `relay_lists` (per-pubkey kind 10002).
const RELAY_DIRECTORY = process.env.MONGO_RELAY_DIRECTORY_COLLECTION || 'relays';

let db, client;

export async function connect() {
  if (db) return db;
  client = new MongoClient(uri);
  await client.connect();
  db = client.db(dbName);
  // pubkey index for query/dedupe perf — does not change the doc shape.
  // Tolerate a pre-existing index (e.g. an imported nostr-beacon dump already
  // carries a *unique* pubkey_1); a spec conflict (code 86) just means it's
  // already there and serving lookups, so it is safe to ignore.
  for (const name of new Set(Object.values(COLLECTIONS))) {
    try {
      await db.collection(name).createIndex({ pubkey: 1 });
    } catch (e) {
      if (e?.code !== 86) throw e;
    }
  }
  return db;
}

export async function close() {
  if (client) await client.close();
  db = client = undefined;
}

/** Latest-wins upsert of a raw event into the collection for its kind. */
export async function upsertEvent(event) {
  const name = COLLECTIONS[event.kind];
  if (!name || !event.pubkey) return false;
  const col = (await connect()).collection(name);
  const existing = await col.findOne({ pubkey: event.pubkey }, { projection: { created_at: 1 } });
  if (existing && existing.created_at >= event.created_at) return false;
  await col.updateOne({ pubkey: event.pubkey }, { $set: { ...event } }, { upsert: true });
  return true;
}

const one = async (kind, pubkey) => (await connect()).collection(COLLECTIONS[kind]).findOne({ pubkey });
export const getProfile = (pubkey) => one(0, pubkey);
export const getFollows = (pubkey) => one(3, pubkey);
export const getRelays = (pubkey) => one(10002, pubkey);

export async function recentProfiles(limit = 10) {
  return (await connect()).collection(COLLECTIONS[0]).find().sort({ created_at: -1 }).limit(limit).toArray();
}

// ---- search ----------------------------------------------------------------

const HEX64 = /^[0-9a-f]{64}$/;
const BECH32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

// Minimal bech32 decode (npub -> 32-byte hex). No checksum check: a bad key
// simply finds nothing on lookup.
function npubToHex(str) {
  const s = String(str).toLowerCase();
  const pos = s.lastIndexOf('1');
  if (pos < 1) return null;
  const words = [];
  for (const ch of s.slice(pos + 1)) { const v = BECH32.indexOf(ch); if (v === -1) return null; words.push(v); }
  let acc = 0, bits = 0; const bytes = [];
  for (const w of words.slice(0, -6)) { acc = (acc << 5) | w; bits += 5; while (bits >= 8) { bits -= 8; bytes.push((acc >> bits) & 0xff); } }
  return bytes.length === 32 ? bytes.map((b) => b.toString(16).padStart(2, '0')).join('') : null;
}

/** Resolve a search term to a 64-hex pubkey if it is one (hex or npub), else null. */
export function toPubkey(q) {
  const s = String(q || '').trim().toLowerCase();
  if (HEX64.test(s)) return s;
  if (s.startsWith('npub1')) return npubToHex(s);
  return null;
}

/** Search profiles: exact key (hex/npub) or full-text over profile content. */
export async function searchProfiles(q, limit = 24) {
  const query = String(q || '').trim();
  if (!query) return [];
  const col = (await connect()).collection(COLLECTIONS[0]);
  const hex = toPubkey(query);
  if (hex) { const p = await col.findOne({ pubkey: hex }); return p ? [p] : []; }
  return col.find({ $text: { $search: query } }, { projection: { score: { $meta: 'textScore' } } })
    .sort({ score: { $meta: 'textScore' } })
    .limit(Math.min(limit, 50)).toArray();
}

// ---- relay directory (firehose health data) --------------------------------

// Fields the directory page needs — keep the projection tight; the raw docs
// also carry publish-test internals and error strings we don't surface in v0.
const RELAY_FIELDS = {
  _id: 0, relay: 1, online: 1, uptime: 1, responseTime: 1, acceptsEvents: 1,
  requiresAuth: 1, requiresPayment: 1, lastChecked: 1, checksOnline: 1, checksTotal: 1,
};

/**
 * Read the relay-health directory. Returns a summary (for the freshness caveat)
 * plus the matching rows. `online` filters to live relays; `sort` is one of
 * 'quality' (uptime desc, latency asc), 'latency', or 'recent' (last checked).
 */
export async function relaysDirectory({ online = false, sort = 'quality', limit = 300 } = {}) {
  const col = (await connect()).collection(RELAY_DIRECTORY);
  const filter = online ? { online: true } : {};
  const sortSpec = sort === 'recent' ? { lastChecked: -1 }
    : sort === 'latency' ? { responseTime: 1 }
    : { uptime: -1, responseTime: 1 }; // 'quality'
  const [total, onlineCount, newest, relays] = await Promise.all([
    col.estimatedDocumentCount(),
    col.countDocuments({ online: true }),
    col.find({}, { projection: { _id: 0, lastChecked: 1 } }).sort({ lastChecked: -1 }).limit(1).toArray(),
    col.find(filter, { projection: RELAY_FIELDS }).sort(sortSpec).limit(Math.min(Number(limit) || 300, 2000)).toArray(),
  ]);
  return { total, online: onlineCount, lastChecked: newest[0]?.lastChecked || null, relays };
}

// ---- graph metrics ---------------------------------------------------------

export async function stats() {
  const db = await connect();
  const [profiles, follows, relays] = await Promise.all([
    db.collection(COLLECTIONS[0]).estimatedDocumentCount(),
    db.collection(COLLECTIONS[3]).estimatedDocumentCount(),
    db.collection(COLLECTIONS[10002]).estimatedDocumentCount(),
  ]);
  return { profiles, follows, relays };
}

/** In-degree: how many follow-lists include this pubkey (uses the follows_1 index). */
export async function followerCount(pubkey) {
  return (await connect()).collection(COLLECTIONS[3]).countDocuments({ follows: pubkey });
}

/** Batched { pk: { followers, following } } for a set of pubkeys (for grids). */
export async function enrichCounts(pubkeys) {
  const fc = (await connect()).collection(COLLECTIONS[3]);
  const ids = [...new Set(pubkeys)].filter(Boolean);
  const out = Object.fromEntries(ids.map((p) => [p, { followers: 0, following: 0 }]));
  if (!ids.length) return out;
  const lists = await fc.find({ pubkey: { $in: ids } }, { projection: { pubkey: 1, count: 1, follows: 1 } }).toArray();
  for (const l of lists) if (out[l.pubkey]) out[l.pubkey].following = l.count ?? (l.follows?.length || 0);
  await Promise.all(ids.map(async (pk) => { out[pk].followers = await fc.countDocuments({ follows: pk }); }));
  return out;
}
