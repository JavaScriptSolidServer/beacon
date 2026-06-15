// Production entrypoint: start the read-only beacon HTTP server.
//
// pm2's launcher does not trigger server.js's `import.meta.url === main`
// guard (it runs the file through its own wrapper), so starting src/server.js
// directly under pm2 loads the module but never calls startServer(). This
// explicit entry guarantees the server boots under any launcher.
//
//   PORT=3001 MONGO_DB=nostr pm2 start serve.js --name beacon
import { startServer } from './src/server.js';

startServer().catch((e) => {
  console.error('[beacon] failed to start:', e);
  process.exit(1);
});
