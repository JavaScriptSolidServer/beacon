// Entry point: run the read API and the relay indexer in one process.
import { startServer } from './src/server.js';
import { runIndexer, parseArgs, USAGE } from './src/indexer.js';

if (parseArgs().help) { console.log(USAGE); process.exit(0); }

await startServer();
await runIndexer(); // honours --hoses / --legacy / --no-legacy (override env)
