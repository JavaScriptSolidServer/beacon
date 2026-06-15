// Relay indexer: subscribe to kind 0 (profile), 3 (follows / social graph),
// and 10002 (relay list), and upsert each raw event into Mongo.
import { SimplePool } from 'nostr-tools/pool';
import { upsertEvent, connect } from './db.js';
import 'dotenv/config';

const RELAYS = (process.env.RELAYS || 'wss://relay.damus.io,wss://nos.lol,wss://relay.primal.net')
  .split(',').map((s) => s.trim()).filter(Boolean);

const KINDS = [0, 3, 10002];

export async function runIndexer() {
  await connect();
  const pool = new SimplePool();
  console.log(`[beacon] indexing kinds ${KINDS.join(',')} from ${RELAYS.length} relays`);

  const sub = pool.subscribeMany(RELAYS, [{ kinds: KINDS }], {
    onevent: async (event) => {
      try {
        if (await upsertEvent(event)) {
          console.log(`[beacon] kind ${event.kind}  ${event.pubkey.slice(0, 12)}…`);
        }
      } catch (e) {
        console.error('[beacon] upsert error:', e.message);
      }
    },
  });

  const stop = () => { sub.close(); pool.close(RELAYS); };
  process.on('SIGINT', () => { stop(); process.exit(0); });
  return { pool, sub, stop };
}

if (import.meta.url === `file://${process.argv[1]}`) runIndexer();
