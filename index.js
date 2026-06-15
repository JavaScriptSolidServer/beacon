// Entry point: run the read API and the relay indexer in one process.
import { startServer } from './src/server.js';
import { runIndexer } from './src/indexer.js';

await startServer();
await runIndexer();
