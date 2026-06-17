// Shared relay-directory helpers, used by any hose that discovers relay URLs
// (follows harvests them from legacy kind-3 content; relay-lists from kind-3…
// sorry, kind-10002 `r` tags). Discovery only seeds the URL — it never touches
// the health metrics the relay-health prober owns.
const RELAY_DIRECTORY = process.env.MONGO_RELAY_DIRECTORY_COLLECTION || 'relays';

// Trailing slash on bare origins (so `wss://r.com` and `wss://r.com/` dedupe);
// keep an explicit path as-is. Non-ws(s) or unparseable URLs return null.
export function canonicalizeRelayUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'wss:' && u.protocol !== 'ws:') return null;
    if (u.pathname === '' || u.pathname === '/') return `${u.protocol}//${u.host}/`;
    return url;
  } catch { return null; }
}

export async function ensureRelayDirectoryIndex(db) {
  await db.collection(RELAY_DIRECTORY).createIndex({ relay: 1 })
    .catch((e) => { if (e?.code !== 85 && e?.code !== 86) throw e; });
}

/**
 * Best-effort discovery: seed newly-seen relay URLs into the directory without
 * touching any existing fields ($setOnInsert). Canonicalizes + dedupes first.
 * Never throws — discovery must never fail an ingest. Returns the count seeded.
 */
export async function harvestRelays(db, urls) {
  const uniq = [...new Set((urls || []).map(canonicalizeRelayUrl).filter(Boolean))];
  if (!uniq.length) return 0;
  await db.collection(RELAY_DIRECTORY).bulkWrite(
    uniq.map((relay) => ({ updateOne: { filter: { relay }, update: { $setOnInsert: { relay } }, upsert: true } })),
    { ordered: false },
  ).catch(() => {});
  return uniq.length;
}
