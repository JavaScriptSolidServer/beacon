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

let db, client;

export async function connect() {
  if (db) return db;
  client = new MongoClient(uri);
  await client.connect();
  db = client.db(dbName);
  // non-unique index for query/dedupe perf — does not change the doc shape
  for (const name of new Set(Object.values(COLLECTIONS))) {
    await db.collection(name).createIndex({ pubkey: 1 });
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
