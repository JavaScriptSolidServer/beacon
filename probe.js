// Production entrypoint: start the relay-health prober.
//
// Like serve.js, this avoids relying on the `import.meta.url === main` guard
// (pm2's launcher runs files through a wrapper, so that guard won't fire). Use:
//
//   PROBE_INTERVAL=3600000 MONGO_DB=nostr pm2 start probe.js --name relay-prober
import { runProber, proberConfig, USAGE } from './src/prober.js';

if (proberConfig().help) { console.log(USAGE); process.exit(0); }

runProber().catch((e) => {
  console.error('[beacon] prober failed to start:', e);
  process.exit(1);
});
