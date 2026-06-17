# beacon

A **did:nostr social-graph indexer** — it indexes Nostr **profiles** (kind 0), **follows** (kind 3, the social graph), and **relay lists** (kind 10002) for pubkeys into MongoDB, and serves them over a small read API.

Useful as the identity substrate for **SSO**: "sign in with did:nostr", plus trust / discovery over the follow graph.

This is a clean reimplementation of [nostr-labs/nostr-beacon](https://github.com/nostr-labs/nostr-beacon), keeping the **same Mongo schema to start** (for regression). Per the [RFC](https://github.com/JavaScriptSolidServer/JavaScriptSolidServer/issues/572), DID-document *generation* will delegate to jss's `buildDidDocument` rather than maintaining a second, divergent generator (the source of the bugs in nostr-labs/nostr-beacon#3).

## Schema (matches the live nostr-beacon)

Each collection stores the **raw Nostr event**, keyed by `pubkey`, **latest-wins** by `created_at`:

| data | kind | collection |
|---|---|---|
| profiles | 0 | `beacon` |
| follows (social graph) | 3 | `follows` |
| relay lists | 10002 | `relay_lists` |

(Collection names are configurable via env so the same Mongo can be read/written interchangeably.)

## Run

```
npm install
cp .env.example .env        # set MONGODB_URI and relays
npm start                   # indexer + read API
# or run separately:
npm run index               # indexer only
npm run serve               # read API only
```

## Read API

- `GET /api/profiles` — recent profiles
- `GET /api/profile/:pubkey`
- `GET /api/follows/:pubkey`
- `GET /api/relays/:pubkey` — that pubkey's kind-10002 relay list
- `GET /api/relays-directory` — relay-health directory (`?online=1`, `?sort=quality|latency|recent`, `?limit=`)

## Status

v0 — MVP: indexer + read API + the regression-compatible schema, plus the DID-document resolution endpoint (`/.well-known/did/nostr/:pubkey.json` via jss's `buildDidDocument`) and a `/relays` health directory.

The indexer is being reworked into composable **hoses** (`src/hoses/`). Phase 1 is the **profiles hose** (kind 0): it schnorr-verifies each event before storing it, so a relay can't inject a forged `did:nostr` profile, and owns its Mongo indexes (incl. the `content_text` search index). Follows (kind 3) and relay lists (kind 10002) still use the raw upsert path until their phases.

## License

MIT
