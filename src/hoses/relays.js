// Shared relay-directory helpers, used by any hose that discovers relay URLs
// (follows harvests them from legacy kind-3 content; relay-lists from kind-10002
// `r` tags) and by the relay-health prober.
//
// SECURITY: relay URLs come from arbitrary, attacker-controllable Nostr events.
// `safeRelayUrl` is the single chokepoint that canonicalizes a URL and rejects
// anything we must never dial — loopback, private/reserved ranges, link-local,
// IP-literals, .onion, and malformed hosts — so the prober can't be turned into
// an SSRF amplifier against our own host or internal network.
const RELAY_DIRECTORY = process.env.MONGO_RELAY_DIRECTORY_COLLECTION || 'relays';

// Max relay URLs harvested from a single event — a real NIP-65 list is tiny;
// a 9,000-tag event is a bomb. Truncate rather than ingest the lot.
export const MAX_HARVEST_PER_EVENT = Number(process.env.RELAY_HARVEST_CAP) || 100;

const DNS_NAME = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;

// Is this hostname a private / loopback / reserved / otherwise un-probeable
// target we must refuse? Operates on the literal host (no DNS resolution).
function isBlockedHost(host) {
  const h = host.toLowerCase().replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  if (h.endsWith('.onion')) return true;            // can't reach without Tor
  if (h === '::1' || h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true; // IPv6 loopback/link-local/ULA
  // IPv4 literal?
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 10 || a === 127 || a === 0 || a >= 224) return true;          // private/loopback/this-host/multicast+reserved
    if (a === 169 && b === 254) return true;                                 // link-local incl. cloud metadata
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;                       // CGNAT
    return true; // any other bare IPv4 literal: relays should use DNS names
  }
  if (/^[0-9a-f:]+$/i.test(h) && h.includes(':')) return true;               // any other IPv6 literal
  return !DNS_NAME.test(h);                                                   // require a real DNS hostname
}

/**
 * Canonicalize + security-screen a relay URL. Returns the normalized wss/ws URL
 * (trailing slash on bare origins), or null if it must not be stored/dialed.
 */
export function safeRelayUrl(url) {
  let u;
  try { u = new URL(String(url)); } catch { return null; }
  if (u.protocol !== 'wss:' && u.protocol !== 'ws:') return null;
  if (isBlockedHost(u.hostname)) return null;
  if (u.pathname === '' || u.pathname === '/') return `${u.protocol}//${u.host}/`;
  return u.toString();
}

// Back-compat alias (older callers/tests): same screening as safeRelayUrl.
export const canonicalizeRelayUrl = safeRelayUrl;

export async function ensureRelayDirectoryIndex(db) {
  await db.collection(RELAY_DIRECTORY).createIndex({ relay: 1 })
    .catch((e) => { if (e?.code !== 85 && e?.code !== 86) throw e; });
}

/**
 * Best-effort discovery: seed newly-seen relay URLs into the directory without
 * touching any existing fields ($setOnInsert). Screens + dedupes first, and
 * caps how many it accepts from one event (bomb protection). Never throws.
 * Returns the count seeded.
 */
export async function harvestRelays(db, urls) {
  const uniq = [...new Set((urls || []).map(safeRelayUrl).filter(Boolean))].slice(0, MAX_HARVEST_PER_EVENT);
  if (!uniq.length) return 0;
  await db.collection(RELAY_DIRECTORY).bulkWrite(
    uniq.map((relay) => ({ updateOne: { filter: { relay }, update: { $setOnInsert: { relay } }, upsert: true } })),
    { ordered: false },
  ).catch(() => {});
  return uniq.length;
}
