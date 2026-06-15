// Thin read API over the indexed social graph.
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getProfile, getFollows, getRelays, recentProfiles, connect, stats, searchProfiles, enrichCounts, followerCount } from './db.js';
import { buildDidDocument } from './diddoc.js';
import 'dotenv/config';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export async function startServer(port = process.env.PORT || 3000) {
  await connect();
  const app = express();
  // Public read-only resolver: allow cross-origin fetches so browser-based
  // did:nostr resolvers can read the documents.
  app.use((_req, res, next) => { res.setHeader('Access-Control-Allow-Origin', '*'); next(); });
  app.use(express.static(PUBLIC));

  // Liveness/readiness: confirms Mongo is reachable (for haproxy httpchk + monitoring).
  app.get('/healthz', async (_req, res) => {
    try { await (await connect()).command({ ping: 1 }); res.json({ ok: true }); }
    catch (e) { res.status(503).json({ ok: false, error: e.message }); }
  });

  // attach { followers, following } to each profile under `_counts`
  const withCounts = async (profiles) => {
    const counts = await enrichCounts(profiles.map((p) => p.pubkey));
    return profiles.map((p) => ({ ...p, _counts: counts[p.pubkey] }));
  };

  // network stats, cached 60s (estimatedDocumentCount is cheap but stable)
  let statsCache = { at: 0, val: null };
  app.get('/api/stats', async (_req, res, next) => {
    try {
      if (!statsCache.val || Date.now() - statsCache.at > 60_000) statsCache = { at: Date.now(), val: await stats() };
      res.json(statsCache.val);
    } catch (e) { next(e); }
  });

  // search by name / nip05 / npub / hex pubkey; rank matches by followers so
  // prominent accounts surface above same-named namesakes.
  app.get('/api/search', async (req, res, next) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 24, 50);
      const pool = await withCounts(await searchProfiles(req.query.q, Math.max(limit, 40)));
      pool.sort((a, b) => (b._counts?.followers || 0) - (a._counts?.followers || 0));
      res.json(pool.slice(0, limit));
    } catch (e) { next(e); }
  });

  app.get('/api/profiles', async (req, res, next) => {
    try { res.json(await withCounts(await recentProfiles(Math.min(Number(req.query.limit) || 30, 100)))); } catch (e) { next(e); }
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
  // UI-facing resolution: the conformant doc + graph counts (followers = in-degree).
  // The .well-known endpoint above stays the pure conformant document.
  app.get('/api/did/:pubkey', async (req, res, next) => {
    try {
      const doc = await resolve(req.params.pubkey);
      if (!doc) return res.status(400).json({ error: 'invalid did:nostr pubkey (expect 64-hex)' });
      const followers = await followerCount(req.params.pubkey.toLowerCase());
      res.json({ ...doc, followersCount: followers, followingCount: doc.follows?.length || 0 });
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
