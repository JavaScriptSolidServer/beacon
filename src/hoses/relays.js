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
  const raw = String(url);
  // Real relay URLs are short and single-scheme. Reject length blowups,
  // whitespace, and a second "://" (embedded scheme) — the signature of
  // concatenated multi-relay junk packed into one tag by broken clients.
  if (raw.length > 120 || /\s/.test(raw) || raw.indexOf('://') !== raw.lastIndexOf('://')) return null;
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'wss:' && u.protocol !== 'ws:') return null;
  if (isBlockedHost(u.hostname)) return null;
  if (u.pathname === '' || u.pathname === '/') return `${u.protocol}//${u.host}/`;
  return u.toString();
}

// Back-compat alias (older callers/tests): same screening as safeRelayUrl.
export const canonicalizeRelayUrl = safeRelayUrl;

const hostOf = (u) => { try { return new URL(u).host; } catch { return null; } };
const isOrigin = (u) => { try { const x = new URL(u); return x.pathname === '/' ? 1 : 0; } catch { return 0; } };
const tms = (x) => (x ? new Date(x).getTime() || 0 : 0);

/**
 * Plan a relay-directory cleanup (pure — pass docs + options, no I/O). Returns
 * docs to delete by category plus URL normalizations. Re-runnable / idempotent.
 *
 * - bad:     fails safeRelayUrl (malformed / SSRF / non-ws)
 * - dups:    multiple docs share a canonical URL — keep the richest
 * - hostSpam: a host has > maxPerHost distinct URLs (path-variant flooding,
 *             e.g. a bomb) — keep the origin + richest few, drop the rest
 * - renames: a surviving doc's stored `relay` ≠ its canonical form
 * - stale:   (if staleDays) a survivor not checked within staleDays
 * - notReal: (if realOnly) survivors that aren't a bare origin that has been
 *            online at least once — i.e. the unverified/dead/path entries
 */
export function planRelaySweep(docs, { maxPerHost = 3, staleDays = 0, now = 0, realOnly = false } = {}) {
  const rich = (a, b) => (b.checksTotal || 0) - (a.checksTotal || 0) || tms(b.lastChecked) - tms(a.lastChecked);
  // 1. screen + canonicalize, group by canonical URL
  const byCanon = new Map();
  const bad = [];
  for (const d of docs) {
    const c = d.relay && safeRelayUrl(d.relay);
    if (!c) { bad.push(d); continue; }
    (byCanon.get(c) || byCanon.set(c, []).get(c)).push(d);
  }
  // 2. dedup: one survivor per canonical (richest history wins)
  const dups = [];
  let survivors = [];
  for (const [canon, ds] of byCanon) {
    ds.sort(rich);
    ds[0]._canon = canon;
    survivors.push(ds[0]);
    dups.push(...ds.slice(1));
  }
  // 3. host cap: trim path-variant flooding per host
  const hostSpam = [];
  if (maxPerHost > 0) {
    const byHost = new Map();
    for (const s of survivors) { const h = hostOf(s._canon); (byHost.get(h) || byHost.set(h, []).get(h)).push(s); }
    const kept = [];
    for (const [, ss] of byHost) {
      if (ss.length <= maxPerHost) { kept.push(...ss); continue; }
      ss.sort((a, b) => isOrigin(b._canon) - isOrigin(a._canon) || rich(a, b)); // origin first, then richest
      kept.push(...ss.slice(0, maxPerHost));
      hostSpam.push(...ss.slice(maxPerHost));
    }
    survivors = kept;
  }
  // 4. realOnly: keep only bare-origin relays online at least once (the
  //    verified/reachable set); everything else is unverified/dead/path junk.
  const notReal = [];
  if (realOnly) {
    const real = [];
    for (const s of survivors) {
      if (isOrigin(s._canon) && (s.checksOnline || 0) >= 1) real.push(s);
      else notReal.push(s);
    }
    survivors = real;
  }
  // 5. normalizations + stale among final survivors
  const renames = [];
  const stale = [];
  const cutoff = staleDays && now ? now - staleDays * 864e5 : null;
  for (const s of survivors) {
    if (s.relay !== s._canon) renames.push({ doc: s, canonical: s._canon });
    if (cutoff && tms(s.lastChecked) < cutoff) stale.push(s);
  }
  return { bad, dups, hostSpam, notReal, renames, stale, kept: survivors.length };
}

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
