// Active relay-health prober — refreshes the `relays` directory the /relays
// page renders. Unlike the subscription hoses this is *active*: it dials every
// known relay, measures reachability + latency, reads the NIP-11 info document
// for auth/payment requirements, and rolls up uptime. Kind-less, so it is not a
// hose — it's a self-scheduling module of its own.
//
// The relay universe is the `relays` collection itself, continuously seeded by
// the follows/relay-lists hoses' URL harvesting.
import { schnorr } from '@noble/curves/secp256k1.js';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js';
import { connect } from './db.js';
import { ensureRelayDirectoryIndex, safeRelayUrl } from './hoses/relays.js';
import { eventId } from './hoses/event.js';
import 'dotenv/config';

const RELAY_DIRECTORY = process.env.MONGO_RELAY_DIRECTORY_COLLECTION || 'relays';
const PROBE_KIND = 20000; // NIP-16 ephemeral: relays relay it but never store it

// Build a signed ephemeral event for the write-test, from a throwaway key.
export function buildTestEvent(privHex, nowMs) {
  const priv = hexToBytes(privHex);
  const e = { pubkey: bytesToHex(schnorr.getPublicKey(priv)), created_at: Math.floor((nowMs || Date.now()) / 1000), kind: PROBE_KIND, tags: [], content: '' };
  const id = eventId(e);
  return { ...e, id, sig: bytesToHex(schnorr.sign(hexToBytes(id), priv)) };
}

// Machine-readable category from a relay's OK message (NIP-01 prefixes:
// pow / auth-required / payment-required / restricted / rate-limited / blocked…).
export function reasonCat(msg) {
  const m = String(msg || '').match(/^\s*([a-z][a-z-]*):/i);
  return m ? m[1].toLowerCase() : (String(msg || '').trim() ? 'rejected' : '');
}

// SECURITY: the prober dials ONLY this curated allowlist — never the harvested
// `relays` directory, which is attacker-influenceable (anyone can publish a
// relay list we harvest). Decoupling the target set from attacker-controlled
// data is what stops the prober being used to dial arbitrary hosts. Expand
// deliberately via PROBE_RELAYS (comma list); safe-then-expand, not the reverse.
export const DEFAULT_PROBE_RELAYS = [
  'wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net',
  'wss://relay.nostr.band', 'wss://nostr.wine', 'wss://relay.snort.social',
  'wss://purplepag.es', 'wss://nostr.mom',
];

/** The curated allowlist of relays the prober always dials (screened). */
export function proberRelays(env = process.env) {
  const raw = env.PROBE_RELAYS ? env.PROBE_RELAYS.split(',') : DEFAULT_PROBE_RELAYS;
  return [...new Set(raw.map((u) => safeRelayUrl(String(u).trim())).filter(Boolean))];
}

/**
 * Build the sweep target set: the allowlist plus already-verified candidates
 * (relays that have been online ≥ 1×), screened and capped. Brand-new
 * harvested candidates are NOT included — only relays that already proved
 * themselves, so a freshly-published relay list can't make us dial new hosts.
 */
export function selectTargets(allowlist, candidates, cap = 1000) {
  const set = new Set(allowlist);
  for (const c of candidates) {
    if (set.size >= cap) break;
    const u = safeRelayUrl(c);
    if (u) set.add(u);
  }
  return [...set].slice(0, cap);
}

export const USAGE = `beacon relay-health prober

Usage: node probe.js [flags]    (or: node src/prober.js [flags])

Flags (override the matching env var):
  --once               run a single sweep and exit (env RUN_ONCE=1)
  --concurrency <n>    relays probed in parallel (env PROBE_CONCURRENCY, default 25)
  --timeout <ms>       per-relay connect/HTTP timeout (env PROBE_TIMEOUT, default 7000)
  --interval <ms>      sweep interval when scheduling (env PROBE_INTERVAL, default 86400000 = daily)
  --max <n>            cap relays probed per sweep (env PROBE_MAX, default 1000)
  -h, --help           show this help

Targets: the allowlist (env PROBE_RELAYS, comma list; default: a small built-in
set) PLUS already-verified relays (online ≥ 1×), capped at --max. Brand-new
harvested candidates are never dialed — only relays that already proved
themselves, so a freshly-published relay list can't redirect our outbound.`;

/** Parse prober CLI flags into an overlay (only keys the user passed). */
export function parseArgs(argv = process.argv.slice(2)) {
  const out = {};
  const numNext = (i) => { const v = Number(argv[i + 1]); return Number.isFinite(v) ? v : undefined; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') out.help = true;
    else if (a === '--once') out.once = true;
    else if (a === '--concurrency') { const v = numNext(i); if (v !== undefined) { out.concurrency = v; i++; } }
    else if (a === '--timeout') { const v = numNext(i); if (v !== undefined) { out.timeout = v; i++; } }
    else if (a === '--interval') { const v = numNext(i); if (v !== undefined) { out.interval = v; i++; } }
    else if (a === '--max') { const v = numNext(i); if (v !== undefined) { out.max = v; i++; } }
  }
  return out;
}

/** Resolve config from env + CLI flags (flags win). Pure — inputs passed in. */
export function proberConfig(env = process.env, argv = process.argv.slice(2)) {
  const flags = parseArgs(argv);
  const pos = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
  return {
    interval: flags.interval ?? pos(env.PROBE_INTERVAL, 86_400_000),
    concurrency: flags.concurrency ?? pos(env.PROBE_CONCURRENCY, 25),
    timeout: flags.timeout ?? pos(env.PROBE_TIMEOUT, 7_000),
    cap: flags.max ?? pos(env.PROBE_MAX, 1_000),
    privkey: env.PROBE_PRIVKEY || null, // throwaway key enables the write-test; off if unset
    once: flags.once || env.RUN_ONCE === '1' || env.RUN_ONCE === 'true',
    help: !!flags.help,
  };
}

/** wss://… -> https://…, ws://… -> http://… (for the NIP-11 fetch). null if unparseable. */
export function relayInfoUrl(wsUrl) {
  try {
    const u = new URL(wsUrl);
    if (u.protocol === 'wss:') u.protocol = 'https:';
    else if (u.protocol === 'ws:') u.protocol = 'http:';
    else return null;
    return u.toString();
  } catch { return null; }
}

/** Extract the health-relevant flags from a NIP-11 relay info document. */
export function nip11Flags(info) {
  const lim = (info && typeof info === 'object' && info.limitation) || {};
  return {
    requiresAuth: !!lim.auth_required,
    requiresPayment: !!lim.payment_required,
    requiresPow: Number(lim.min_pow_difficulty) > 0,
    restrictedWrites: !!lim.restricted_writes,
  };
}

/**
 * Open a WebSocket; resolve { online, responseTime, error }. If `testEvent` is
 * given, also publish it on open and capture the relay's OK → `publish:
 * {accepted, reason}` (ground-truth writeability). Never rejects.
 */
export function checkRelay(url, timeoutMs, testEvent = null) {
  return new Promise((resolve) => {
    const start = Date.now();
    let done = false, ws, timer, openMs = null;
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); try { ws?.close(); } catch {} resolve(r); };
    // On timeout: if we opened, the relay is online but didn't ack our event.
    timer = setTimeout(() => finish(openMs == null
      ? { online: false, responseTime: null, error: 'timeout' }
      : { online: true, responseTime: openMs, error: null, publish: testEvent ? { accepted: false, reason: 'timeout' } : undefined }), timeoutMs);
    try { ws = new WebSocket(url); } catch (e) { return finish({ online: false, responseTime: null, error: String(e?.message || e) }); }
    ws.addEventListener('open', () => {
      openMs = Date.now() - start;
      if (testEvent) ws.send(JSON.stringify(['EVENT', testEvent])); // wait for OK
      else finish({ online: true, responseTime: openMs, error: null });
    });
    ws.addEventListener('message', (m) => {
      if (!testEvent) return;
      try {
        const d = JSON.parse(typeof m.data === 'string' ? m.data : m.data.toString());
        if (d[0] === 'OK' && d[1] === testEvent.id) finish({ online: true, responseTime: openMs, error: null, publish: { accepted: !!d[2], reason: d[2] ? '' : reasonCat(d[3]) } });
        else if (d[0] === 'AUTH') finish({ online: true, responseTime: openMs, error: null, publish: { accepted: false, reason: 'auth-required' } });
      } catch { /* ignore malformed frames */ }
    });
    ws.addEventListener('error', (e) => finish(openMs == null
      ? { online: false, responseTime: null, error: e?.message || 'error' }
      : { online: true, responseTime: openMs, error: null, publish: testEvent ? { accepted: false, reason: 'error' } : undefined }));
  });
}

/** Fetch + parse the NIP-11 info doc. Returns flags, or null on any failure. */
export async function fetchNip11(url, timeoutMs) {
  const httpUrl = relayInfoUrl(url);
  if (!httpUrl) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(httpUrl, { headers: { Accept: 'application/nostr+json' }, signal: ctrl.signal });
    if (!res.ok) return null;
    return nip11Flags(await res.json());
  } catch { return null; }
  finally { clearTimeout(timer); }
}

/** Probe one relay and persist the result (uptime rolled up from running totals). */
export async function probeRelay(db, relay, cfg, testEvent = null) {
  const conn = await checkRelay(relay, cfg.timeout, testEvent);
  const nip11 = conn.online ? await fetchNip11(relay, cfg.timeout) : null;
  await db.collection(RELAY_DIRECTORY).updateOne({ relay }, [
    {
      $set: {
        lastChecked: '$$NOW',
        online: conn.online,
        responseTime: conn.responseTime,
        lastError: conn.error,
        ...(nip11 ? { requiresAuth: nip11.requiresAuth, requiresPayment: nip11.requiresPayment, requiresPow: nip11.requiresPow, restrictedWrites: nip11.restrictedWrites } : {}),
        ...(conn.publish ? { acceptsEvents: conn.publish.accepted, publishReason: conn.publish.reason, lastPublishTest: '$$NOW' } : {}),
        checksTotal: { $add: [{ $ifNull: ['$checksTotal', 0] }, 1] },
        checksOnline: { $add: [{ $ifNull: ['$checksOnline', 0] }, conn.online ? 1 : 0] },
      },
    },
    { $set: { uptime: { $cond: [{ $gt: ['$checksTotal', 0] }, { $multiply: [{ $divide: ['$checksOnline', '$checksTotal'] }, 100] }, null] } } },
  ], { upsert: true });
  return conn;
}

// Run `fn` over `items` with at most `concurrency` in flight.
async function mapPool(items, concurrency, fn) {
  let i = 0;
  const worker = async () => { while (i < items.length) { const idx = i++; await fn(items[idx], idx); } };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker));
}

/** Sweep targets: allowlist ∪ relays we already track (stalest first), capped.
 * Membership = `lastChecked` exists (we've probed it before) — decoupled from
 * the uptime counters so those can be reset without losing the rotation, and
 * so offline-but-known relays stay in rotation (and can recover). Brand-new
 * harvested candidates (never probed) are excluded. */
async function sweepTargets(db, cfg) {
  const tracked = await db.collection(RELAY_DIRECTORY)
    .find({ lastChecked: { $exists: true } }, { projection: { relay: 1, _id: 0 } })
    .sort({ lastChecked: 1 }).limit(cfg.cap).toArray();
  return selectTargets(proberRelays(), tracked.map((d) => d.relay), cfg.cap);
}

/** One sweep over the allowlist + verified candidates (never new harvest). */
export async function sweepOnce(db, cfg) {
  const relays = await sweepTargets(db, cfg);
  // One ephemeral test event per sweep (only if a throwaway key is configured).
  const testEvent = cfg.privkey ? buildTestEvent(cfg.privkey) : null;
  let online = 0;
  await mapPool(relays, cfg.concurrency, async (relay) => {
    try { if ((await probeRelay(db, relay, cfg, testEvent)).online) online++; }
    catch (e) { console.error(`[beacon] probe error ${relay}: ${e.message}`); }
  });
  console.log(`[beacon] relay sweep: ${online}/${relays.length} online (allowlist + verified, cap ${cfg.cap}${testEvent ? ', write-test on' : ''})`);
  return { total: relays.length, online };
}

export async function runProber() {
  const cfg = proberConfig();
  const db = await connect();
  await ensureRelayDirectoryIndex(db);
  if (cfg.once) { await sweepOnce(db, cfg); return { stop() {} }; }
  console.log(`[beacon] relay-health prober: every ${Math.round(cfg.interval / 60000)}min, concurrency ${cfg.concurrency}, timeout ${cfg.timeout}ms, write-test ${cfg.privkey ? 'on' : 'off'}`);
  await sweepOnce(db, cfg);
  const timer = setInterval(() => sweepOnce(db, cfg).catch((e) => console.error('[beacon] sweep error:', e.message)), cfg.interval);
  const stop = () => clearInterval(timer);
  process.on('SIGINT', () => { stop(); process.exit(0); });
  process.on('SIGTERM', () => { stop(); process.exit(0); });
  return { stop };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (proberConfig().help) { console.log(USAGE); process.exit(0); }
  runProber();
}
