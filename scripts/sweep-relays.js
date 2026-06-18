// Relay-directory data sweep: drops bad URLs, de-dups, trims per-host
// path-variant flooding, normalizes survivors, and (optionally) prunes stale.
// Pure logic lives in planRelaySweep (src/hoses/relays.js); this is just I/O.
//
//   node scripts/sweep-relays.js                 # dry run (report only)
//   node scripts/sweep-relays.js --apply         # execute
//   node scripts/sweep-relays.js --max-per-host=3 --stale=7 --apply
import { connect, close } from '../src/db.js';
import { planRelaySweep } from '../src/hoses/relays.js';
import 'dotenv/config';

const RELAY_DIRECTORY = process.env.MONGO_RELAY_DIRECTORY_COLLECTION || 'relays';
const APPLY = process.argv.includes('--apply');
const numArg = (name, dflt) => { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? Number(a.split('=')[1]) : dflt; };
const maxPerHost = numArg('max-per-host', 3);
const staleDays = numArg('stale', 0);

const db = await connect();
const col = db.collection(RELAY_DIRECTORY);
const docs = await col.find({}, { projection: { relay: 1, checksTotal: 1, lastChecked: 1 } }).toArray();

const plan = planRelaySweep(docs, { maxPerHost, staleDays, now: Date.now() });
const delIds = [...new Set([...plan.bad, ...plan.dups, ...plan.hostSpam, ...(staleDays ? plan.stale : [])].map((d) => d._id))];

console.log(`[sweep] ${docs.length} relays | bad ${plan.bad.length} | dup ${plan.dups.length} | host-spam ${plan.hostSpam.length} | renorm ${plan.renames.length}`
  + (staleDays ? ` | stale>${staleDays}d ${plan.stale.length}` : '') + ` | keep ${plan.kept}`);
console.log(`[sweep] maxPerHost=${maxPerHost}  ->  would delete ${delIds.length}, normalize ${plan.renames.length}  (${APPLY ? 'APPLYING' : 'dry run — pass --apply'})`);

if (APPLY) {
  for (let i = 0; i < delIds.length; i += 1000) await col.deleteMany({ _id: { $in: delIds.slice(i, i + 1000) } });
  for (const r of plan.renames) await col.updateOne({ _id: r.doc._id }, { $set: { relay: r.canonical } }).catch(() => {});
  console.log(`[sweep] deleted ${delIds.length}, normalized ${plan.renames.length}; ${await col.estimatedDocumentCount()} remain`);
}
await close();
