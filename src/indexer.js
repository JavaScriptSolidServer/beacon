// Relay indexer, from scratch over raw WebSocket (no nostr-tools).
// Nostr is a simple protocol over WS: send ["REQ", subId, filter], receive
// ["EVENT", subId, event]. Node 24 has a built-in global WebSocket.
//
// Ingestion is composed of "hoses" (see src/hoses/), each owning a set of
// event kinds. Which hoses run is a switch — the `HOSES` env (comma list of
// names; default: all registered) — so a deploy can run a single hose without
// double-writing against the legacy firehose processes during the migration.
import { upsertEvent, connect } from './db.js';
import profilesHose from './hoses/profiles.js';
import followsHose from './hoses/follows.js';
import relaylistsHose from './hoses/relaylists.js';
import 'dotenv/config';

const RELAYS = (process.env.RELAYS || 'wss://relay.damus.io,wss://nos.lol,wss://relay.primal.net')
  .split(',').map((s) => s.trim()).filter(Boolean);

// All hoses that exist (grows each phase). `planIngest` selects which run.
// Every event kind now has a hose, so there are no legacy kinds left — the
// raw-upsert fallback and its INDEX_LEGACY_KINDS switch remain only as a safety
// net for any kind a future phase adds before its hose lands.
const ALL_HOSES = [profilesHose, followsHose, relaylistsHose];
const LEGACY_KINDS = [];

/**
 * Resolve the ingest plan from the registered hoses + env switches. Pure (all
 * inputs passed in) so it's unit-testable. Returns the active hoses, a
 * kind→hose lookup, the union of kinds to subscribe to, and the legacy state.
 */
export function planIngest(allHoses = ALL_HOSES, env = process.env, legacyKindsAll = LEGACY_KINDS) {
  const want = (env.HOSES || allHoses.map((h) => h.name).join(','))
    .split(',').map((s) => s.trim()).filter(Boolean);
  const hoses = allHoses.filter((h) => want.includes(h.name));
  const unknown = want.filter((n) => !allHoses.some((h) => h.name === n));
  const legacy = env.INDEX_LEGACY_KINDS !== '0' && env.INDEX_LEGACY_KINDS !== 'false';
  const hoseFor = (kind) => hoses.find((h) => h.kinds.includes(kind));
  const legacyKinds = legacy ? legacyKindsAll.filter((k) => !hoseFor(k)) : [];
  const kinds = [...new Set([...hoses.flatMap((h) => h.kinds), ...legacyKinds])];
  return { hoses, hoseFor, kinds, legacy, legacyKinds, unknown };
}

const SUB_ID = 'beacon';
const RECONNECT_MS = 3000;

export const USAGE = `beacon indexer — firehose into MongoDB

Usage: node index.js [flags]    (or: node src/indexer.js [flags])

Flags (override the matching env var):
  --hoses <list>    comma list of hose names to run (env HOSES; default: all)
  --no-legacy       disable the raw-upsert fallback for un-migrated kinds (INDEX_LEGACY_KINDS=0)
  --legacy          force the legacy fallback on
  -h, --help        show this help

Env: MONGODB_URI, MONGO_DB, RELAYS, PORT — see .env.example`;

/**
 * Parse indexer CLI flags into an env-overlay (only keys the user passed).
 * Merged over process.env by runIndexer so flags win and env is the fallback.
 */
export function parseArgs(argv = process.argv.slice(2)) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') out.help = true;
    else if (a === '--no-legacy') out.INDEX_LEGACY_KINDS = '0';
    else if (a === '--legacy') out.INDEX_LEGACY_KINDS = '1';
    else if (a === '--hoses' || a.startsWith('--hoses=')) {
      const next = argv[i + 1];
      out.HOSES = a.includes('=') ? a.slice(a.indexOf('=') + 1)
        : (next && !next.startsWith('--') ? argv[++i] : '');
    }
  }
  return out;
}

function connectRelay(url, kinds, onEvent) {
  let ws, closed = false, timer;
  const open = () => {
    if (closed) return;
    ws = new WebSocket(url);
    ws.addEventListener('open', () => ws.send(JSON.stringify(['REQ', SUB_ID, { kinds }])));
    ws.addEventListener('message', (m) => {
      try {
        const msg = JSON.parse(typeof m.data === 'string' ? m.data : m.data.toString());
        if (msg[0] === 'EVENT' && msg[2]) onEvent(msg[2]); // ["EVENT", subId, event]
      } catch { /* ignore malformed frames */ }
    });
    ws.addEventListener('error', () => { try { ws.close(); } catch {} });
    ws.addEventListener('close', () => { if (!closed) timer = setTimeout(open, RECONNECT_MS); });
  };
  open();
  return () => { closed = true; clearTimeout(timer); try { ws?.close(); } catch {} };
}

export async function runIndexer() {
  const db = await connect();
  // CLI flags override env; env (process.env / .env) is the fallback.
  const env = { ...process.env, ...parseArgs() };
  const { hoses, hoseFor, kinds, legacy, unknown } = planIngest(ALL_HOSES, env);
  if (unknown.length) console.warn(`[beacon] unknown hose(s) in HOSES, ignored: ${unknown.join(', ')}`);
  if (!kinds.length) { console.warn('[beacon] no hoses enabled and no legacy kinds — nothing to index'); return { stop() {} }; }
  for (const h of hoses) await h.ensureIndexes(db);
  console.log(`[beacon] hoses: [${hoses.map((h) => h.name).join(', ') || 'none'}]  legacy kinds: ${legacy ? 'on' : 'off'}  subscribing kinds ${kinds.join(',')} from ${RELAYS.length} relays`);
  const onEvent = async (event) => {
    try {
      const hose = hoseFor(event.kind);
      let stored;
      if (hose) stored = await hose.ingest(event, db);
      else if (legacy) stored = await upsertEvent(event);
      else return; // not an enabled kind
      if (stored) console.log(`[beacon] kind ${event.kind}  ${String(event.pubkey).slice(0, 12)}…`);
    } catch (e) {
      console.error('[beacon] ingest error:', e.message);
    }
  };
  const stoppers = RELAYS.map((url) => connectRelay(url, kinds, onEvent));
  const stop = () => stoppers.forEach((s) => s());
  process.on('SIGINT', () => { stop(); process.exit(0); });
  process.on('SIGTERM', () => { stop(); process.exit(0); });
  return { stop };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (parseArgs().help) { console.log(USAGE); process.exit(0); }
  runIndexer();
}
