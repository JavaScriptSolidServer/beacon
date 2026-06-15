// Thin read API over the indexed social graph.
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getProfile, getFollows, getRelays, recentProfiles, connect } from './db.js';
import { buildDidDocument } from './diddoc.js';
import 'dotenv/config';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export async function startServer(port = process.env.PORT || 3000) {
  await connect();
  const app = express();
  app.use(express.static(PUBLIC));

  app.get('/api/profiles', async (_req, res, next) => {
    try { res.json(await recentProfiles(10)); } catch (e) { next(e); }
  });
  app.get('/api/profile/:pubkey', async (req, res, next) => {
    try { res.json(await getProfile(req.params.pubkey)); } catch (e) { next(e); }
  });
  app.get('/api/follows/:pubkey', async (req, res, next) => {
    try { res.json(await getFollows(req.params.pubkey)); } catch (e) { next(e); }
  });
  app.get('/api/relays/:pubkey', async (req, res, next) => {
    try { res.json(await getRelays(req.params.pubkey)); } catch (e) { next(e); }
  });

  // did:nostr resolution — build the conformant DID document from the index
  const resolve = async (pubkey) => {
    const [profile, follows, relays] = await Promise.all([
      getProfile(pubkey), getFollows(pubkey), getRelays(pubkey),
    ]);
    return buildDidDocument(pubkey, { profile, follows, relays });
  };
  app.get('/.well-known/did/nostr/:pubkey.json', async (req, res, next) => {
    try {
      const doc = await resolve(req.params.pubkey);
      if (!doc) return res.status(400).json({ error: 'invalid did:nostr pubkey (expect 64-hex)' });
      res.setHeader('Content-Type', 'application/did+json');
      res.json(doc);
    } catch (e) { next(e); }
  });
  app.get('/api/did/:pubkey', async (req, res, next) => {
    try {
      const doc = await resolve(req.params.pubkey);
      if (!doc) return res.status(400).json({ error: 'invalid did:nostr pubkey (expect 64-hex)' });
      res.json(doc);
    } catch (e) { next(e); }
  });

  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));

  const server = await listenWithSkip(app, Number(port) || 3000);
  console.log(`[beacon] serving on http://localhost:${server.address().port}`);
  return server;
}

// Try `port`, skipping to the next port on EADDRINUSE (so a busy 3000 just moves on).
function listenWithSkip(app, port, attempts = 25) {
  return new Promise((resolve, reject) => {
    const tryPort = (p, left) => {
      const server = app.listen(p);
      server.once('listening', () => resolve(server));
      server.once('error', (e) => {
        if (e.code === 'EADDRINUSE' && left > 0) { console.log(`[beacon] port ${p} busy, skipping…`); tryPort(p + 1, left - 1); }
        else reject(e);
      });
    };
    tryPort(port, attempts);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) startServer();
