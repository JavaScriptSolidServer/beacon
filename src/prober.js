// Active relay-health prober — refreshes the `relays` directory the /relays
// page renders. Unlike the subscription hoses this is *active*: it dials every
// known relay, measures reachability + latency, reads the NIP-11 info document
// for auth/payment requirements, and rolls up uptime. Kind-less, so it is not a
// hose — it's a self-scheduling module of its own.
//
// The relay universe is the `relays` collection itself, continuously seeded by
// the follows/relay-lists hoses' URL harvesting.
import { connect } from './db.js';
import { ensureRelayDirectoryIndex, safeRelayUrl } from './hoses/relays.js';
import 'dotenv/config';

const RELAY_DIRECTORY = process.env.MONGO_RELAY_DIRECTORY_COLLECTION || 'relays';

export const USAGE = `beacon relay-health prober

Usage: node probe.js [flags]    (or: node src/prober.js [flags])

Flags (override the matching env var):
  --once               run a single sweep and exit (env RUN_ONCE=1)
  --concurrency <n>    relays probed in parallel (env PROBE_CONCURRENCY, default 25)
  --timeout <ms>       per-relay connect/HTTP timeout (env PROBE_TIMEOUT, default 7000)
  --interval <ms>      sweep interval when scheduling (env PROBE_INTERVAL, default 3600000)
  -h, --help           show this help`;

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
  }
  return out;
}

/** Resolve config from env + CLI flags (flags win). Pure — inputs passed in. */
export function proberConfig(env = process.env, argv = process.argv.slice(2)) {
  const flags = parseArgs(argv);
  const pos = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
  return {
    interval: flags.interval ?? pos(env.PROBE_INTERVAL, 3_600_000),
    concurrency: flags.concurrency ?? pos(env.PROBE_CONCURRENCY, 25),
    timeout: flags.timeout ?? pos(env.PROBE_TIMEOUT, 7_000),
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
  return { requiresAuth: !!lim.auth_required, requiresPayment: !!lim.payment_required };
}

/** Open a WebSocket; resolve { online, responseTime, error }. Never rejects. */
export function checkRelay(url, timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    let done = false, ws, timer;
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); try { ws?.close(); } catch {} resolve(r); };
    timer = setTimeout(() => finish({ online: false, responseTime: null, error: 'timeout' }), timeoutMs);
    try { ws = new WebSocket(url); } catch (e) { return finish({ online: false, responseTime: null, error: String(e?.message || e) }); }
    ws.addEventListener('open', () => finish({ online: true, responseTime: Date.now() - start, error: null }));
    ws.addEventListener('error', (e) => finish({ online: false, responseTime: null, error: e?.message || 'error' }));
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
export async function probeRelay(db, relay, cfg) {
  const conn = await checkRelay(relay, cfg.timeout);
  const nip11 = conn.online ? await fetchNip11(relay, cfg.timeout) : null;
  await db.collection(RELAY_DIRECTORY).updateOne({ relay }, [
    {
      $set: {
        lastChecked: '$$NOW',
        online: conn.online,
        responseTime: conn.responseTime,
        lastError: conn.error,
        ...(nip11 ? { requiresAuth: nip11.requiresAuth, requiresPayment: nip11.requiresPayment } : {}),
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

/** One full sweep over every relay in the directory. Returns { total, online }. */
export async function sweepOnce(db, cfg) {
  const docs = await db.collection(RELAY_DIRECTORY).find({}, { projection: { relay: 1, _id: 0 } }).toArray();
  const all = [...new Set(docs.map((d) => d.relay).filter(Boolean))];
  // Defense-in-depth: never dial loopback/private/reserved targets, even if
  // junk slipped into the directory before harvest hardening (SSRF guard).
  const relays = all.filter((r) => safeRelayUrl(r));
  const skipped = all.length - relays.length;
  let online = 0;
  await mapPool(relays, cfg.concurrency, async (relay) => {
    try { if ((await probeRelay(db, relay, cfg)).online) online++; }
    catch (e) { console.error(`[beacon] probe error ${relay}: ${e.message}`); }
  });
  console.log(`[beacon] relay sweep: ${online}/${relays.length} online${skipped ? ` (skipped ${skipped} unsafe)` : ''}`);
  return { total: relays.length, online, skipped };
}

export async function runProber() {
  const cfg = proberConfig();
  const db = await connect();
  await ensureRelayDirectoryIndex(db);
  if (cfg.once) { await sweepOnce(db, cfg); return { stop() {} }; }
  console.log(`[beacon] relay-health prober: every ${Math.round(cfg.interval / 60000)}min, concurrency ${cfg.concurrency}, timeout ${cfg.timeout}ms`);
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
