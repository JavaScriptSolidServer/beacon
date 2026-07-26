// Thin read API over the indexed social graph.
import express from 'express';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getProfile, getFollows, getRelays, recentProfiles, connect, stats, searchProfiles, enrichCounts, followerCount, relaysDirectory } from './db.js';
import { buildDidDocument } from './diddoc.js';
import 'dotenv/config';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const SITE = process.env.SITE_URL || 'https://nostr.social';

// ---- server-rendered OGP (social crawlers don't run JS) --------------------
const escAttr = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let SHELL;
const shell = () => (SHELL ??= readFileSync(path.join(PUBLIC, 'index.html'), 'utf8'));

// Inject <title> + Open Graph / Twitter meta into the SPA shell at <!--OGP-->.
function renderShell(meta = {}) {
  const m = {
    title: 'nostr.social · a directory of did:nostr identities',
    description: 'Profiles, the follow graph, and a verifiable DID document for every did:nostr key — indexed live from Nostr.',
    url: `${SITE}/`, type: 'website', ...meta,
  };
  const image = m.image || `${SITE}/og.png`; // fall back to the site banner
  const tags = [
    `<title>${escAttr(m.title)}</title>`,
    `<meta name="description" content="${escAttr(m.description)}">`,
    `<meta property="og:site_name" content="nostr.social">`,
    `<meta property="og:type" content="${escAttr(m.type)}">`,
    `<meta property="og:title" content="${escAttr(m.title)}">`,
    `<meta property="og:description" content="${escAttr(m.description)}">`,
    `<meta property="og:url" content="${escAttr(m.url)}">`,
    `<meta property="og:image" content="${escAttr(image)}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${escAttr(m.title)}">`,
    `<meta name="twitter:description" content="${escAttr(m.description)}">`,
    `<meta name="twitter:image" content="${escAttr(image)}">`,
  ].join('\n  ');
  // Function replacements so `$`-sequences in the payload are inert.
  return shell().replace('<!--OGP-->', () => tags).replace('<!--DATA-->', () => m.dataIsland || '');
}

// ---- /relays data island ---------------------------------------------------
// The directory embedded in the page as typed data objects, so the content is
// crawlable and first paint needs no API round-trip. `type: "Relay"` matches
// the service type in resolved did:nostr DID documents.
export function relaysIslandHtml(dir, site = SITE) {
  const island = {
    '@context': 'https://w3id.org/nostr/context',
    id: `${site}/relays`,
    counts: dir.counts,
    lastChecked: dir.lastChecked,
    relays: (dir.relays || []).map((r) => ({ type: 'Relay', ...r })),
  };
  // `<` must never appear literally: a hostile relay URL containing
  // "</script>" would otherwise break out of the island.
  const json = JSON.stringify(island).replace(/</g, '\\u003c');
  return `<script type="application/json" id="relays-data">${json}</script>`;
}

const RELAYS_ISLAND_TTL = 60_000; // the prober refreshes slowly; spare Mongo a per-view aggregate
let relaysIslandCache = { at: 0, html: '' };
async function relaysIsland() {
  if (Date.now() - relaysIslandCache.at > RELAYS_ISLAND_TTL) {
    relaysIslandCache = { at: Date.now(), html: relaysIslandHtml(await relaysDirectory()) };
  }
  return relaysIslandCache.html;
}

export async function startServer(port = process.env.PORT || 3000) {
  await connect();
  const app = express();
  // Public read-only resolver: allow cross-origin fetches so browser-based
  // did:nostr resolvers can read the documents.
  app.use((_req, res, next) => { res.setHeader('Access-Control-Allow-Origin', '*'); next(); });
  app.use(express.static(PUBLIC, { index: false }));

  // home shell (default OGP)
  app.get('/', (_req, res) => res.type('html').send(renderShell()));

  // "link your pod" onboarding shell
  app.get('/link', (_req, res) => res.type('html').send(renderShell({
    title: 'Link your pod · nostr.social',
    description: 'Link your nostr key to a Solid pod so did:nostr resolves to your WebID — one-click sign-in via jss.live SSO.',
    url: `${SITE}/link`,
  })));

  // relay directory shell, with the directory embedded as a data island
  app.get('/relays', async (_req, res) => {
    let dataIsland = '';
    try { dataIsland = await relaysIsland(); }
    catch { /* island is progressive enhancement; the page falls back to the API */ }
    res.type('html').send(renderShell({
      title: 'Relay directory · nostr.social',
      description: 'A health-checked directory of Nostr relays — uptime, latency, write-acceptance, and paid/auth requirements.',
      url: `${SITE}/relays`,
      dataIsland,
    }));
  });

  // per-profile shell at /<pubkey> with that identity's OGP (crawlable canonical
  // URL). RegExp route constrained to 64-hex, so it never collides with /api,
  // /healthz, /.well-known, or static assets.
  app.get(/^\/([0-9a-f]{64})$/, async (req, res, next) => {
    try {
      const id = req.params[0].toLowerCase();
      const p = await getProfile(id);
      let c = {}; try { c = JSON.parse(p?.content || '{}'); } catch { /* malformed */ }
      const name = c.name || c.display_name || `did:nostr:${id.slice(0, 8)}…`;
      const about = String(c.about || `A did:nostr identity · ${id.slice(0, 16)}…`).replace(/\s+/g, ' ').slice(0, 180);
      res.type('html').send(renderShell({
        title: `${name} · nostr.social`, description: about, url: `${SITE}/${id}`,
        type: 'profile', image: c.picture || '',
      }));
    } catch (e) { next(e); }
  });

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

  // relay-health directory (firehose data): { counts, lastChecked, relays }
  app.get('/api/relays-directory', async (req, res, next) => {
    try {
      res.json(await relaysDirectory({
        filter: req.query.filter,
        sort: req.query.sort,
        limit: req.query.limit,
      }));
    } catch (e) { next(e); }
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
