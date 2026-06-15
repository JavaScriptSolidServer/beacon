// Relay indexer, from scratch over raw WebSocket (no nostr-tools).
// Nostr is a simple protocol over WS: send ["REQ", subId, filter], receive
// ["EVENT", subId, event]. Node 24 has a built-in global WebSocket.
//
// Subscribes to kind 0 (profile), 3 (follows / social graph), 10002 (relay
// list) and upserts each raw event into Mongo.
import { upsertEvent, connect } from './db.js';
import 'dotenv/config';

const RELAYS = (process.env.RELAYS || 'wss://relay.damus.io,wss://nos.lol,wss://relay.primal.net')
  .split(',').map((s) => s.trim()).filter(Boolean);

const KINDS = [0, 3, 10002];
const SUB_ID = 'beacon';
const RECONNECT_MS = 3000;

function connectRelay(url, onEvent) {
  let ws, closed = false, timer;
  const open = () => {
    if (closed) return;
    ws = new WebSocket(url);
    ws.addEventListener('open', () => ws.send(JSON.stringify(['REQ', SUB_ID, { kinds: KINDS }])));
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
  await connect();
  console.log(`[beacon] indexing kinds ${KINDS.join(',')} from ${RELAYS.length} relays`);
  const onEvent = async (event) => {
    try {
      if (await upsertEvent(event)) console.log(`[beacon] kind ${event.kind}  ${String(event.pubkey).slice(0, 12)}…`);
    } catch (e) {
      console.error('[beacon] upsert error:', e.message);
    }
  };
  const stoppers = RELAYS.map((url) => connectRelay(url, onEvent));
  const stop = () => stoppers.forEach((s) => s());
  process.on('SIGINT', () => { stop(); process.exit(0); });
  process.on('SIGTERM', () => { stop(); process.exit(0); });
  return { stop };
}

if (import.meta.url === `file://${process.argv[1]}`) runIndexer();
