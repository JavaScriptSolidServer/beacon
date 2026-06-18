// One-off: purge relay-directory docs whose URL fails the SSRF/format screen
// (loopback, private/reserved IPs, .onion, IP-literals, malformed hosts).
// Uses the exact same `safeRelayUrl` the harvest + prober now enforce.
//
//   node scripts/clean-relays.js --dry   # report only
//   node scripts/clean-relays.js         # delete
import { connect, close } from '../src/db.js';
import { safeRelayUrl } from '../src/hoses/relays.js';
import 'dotenv/config';

const RELAY_DIRECTORY = process.env.MONGO_RELAY_DIRECTORY_COLLECTION || 'relays';
const DRY = process.argv.includes('--dry');

const db = await connect();
const col = db.collection(RELAY_DIRECTORY);
const before = await col.estimatedDocumentCount();

const bad = [];
for await (const d of col.find({}, { projection: { relay: 1 } })) {
  if (!d.relay || !safeRelayUrl(d.relay)) bad.push(d._id);
}
console.log(`[clean] ${before} relays, ${bad.length} unsafe/malformed (${DRY ? 'dry run' : 'deleting'})`);

if (bad.length && !DRY) {
  for (let i = 0; i < bad.length; i += 1000) {
    await col.deleteMany({ _id: { $in: bad.slice(i, i + 1000) } });
  }
  console.log(`[clean] deleted ${bad.length}; ${await col.estimatedDocumentCount()} remain`);
}
await close();
