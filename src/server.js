// Thin read API over the indexed social graph.
import express from 'express';
import { getProfile, getFollows, getRelays, recentProfiles, connect } from './db.js';
import 'dotenv/config';

export async function startServer(port = process.env.PORT || 3000) {
  await connect();
  const app = express();

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

  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  app.listen(port, () => console.log(`[beacon] read API on :${port}`));
  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) startServer();
