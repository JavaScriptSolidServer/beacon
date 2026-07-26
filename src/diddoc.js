// Build a spec-conformant did:nostr DID document from indexed events.
//
// Implements the current spec (https://nostrcg.github.io/did-nostr/):
//   - @context: did/v1 + cid/v1 + nostr/context   (cf. nostrcg/did-nostr#136/#139)
//   - type: DIDNostr
//   - Multikey VM with publicKeyMultibase = f + e701 + 02 + <x-only hex>
//   - enhanced: profile (kind 0), follows (kind 3), service/Relay (kind 10002)
//   - profile.created_at (kind-0 created_at, Unix seconds; spec #117)
//   - follows bounded to a subset; the full signed list is the kind-3 event
//     on the relays (spec #104/#125)
//   - modified (dcterms:modified, ISO-8601) = max(created_at) over the signed
//     parts composed into the document (spec #106)
//
// Per RFC JavaScriptSolidServer/JavaScriptSolidServer#572 this is intended to
// converge with jss's shared `buildDidDocument` once that is extracted as a
// reusable module; until then beacon builds the conformant doc directly so it
// is correct now (and avoids the divergent-generator bugs of nostr-labs/nostr-beacon#3).

const HEX64 = /^[0-9a-f]{64}$/;

// Upper bound on follows inlined into the document. Large lists would bloat a
// cacheable document; the complete signed list is the kind-3 event on the relays.
const FOLLOWS_LIMIT = 500;

// dcterms:modified serialized as ISO-8601 UTC (no sub-second precision) from a
// Nostr created_at (Unix seconds). Returns null for anything that is not a sane
// integer timestamp or does not map to a representable date, so the public
// resolver path never throws on a corrupt/hostile created_at.
const isoFromUnix = (sec) => {
  if (!Number.isSafeInteger(sec)) return null;
  const d = new Date(sec * 1000);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().replace(/\.\d{3}Z$/, 'Z');
};

export function buildDidDocument(pubkey, { profile, follows, relays } = {}) {
  const hex = String(pubkey || '').toLowerCase();
  if (!HEX64.test(hex)) return null;
  const did = `did:nostr:${hex}`;

  const doc = {
    '@context': ['https://www.w3.org/ns/did/v1', 'https://www.w3.org/ns/cid/v1', 'https://w3id.org/nostr/context'],
    id: did,
    type: 'DIDNostr',
    verificationMethod: [{
      id: `${did}#key1`,
      type: 'Multikey',
      controller: did,
      publicKeyMultibase: `fe70102${hex}`,
    }],
    authentication: ['#key1'],
    assertionMethod: ['#key1'],
  };

  // kind 0 -> profile (+ alsoKnownAs)
  if (profile?.content) {
    try {
      const c = JSON.parse(profile.content);
      const p = {};
      for (const k of ['name', 'about', 'picture', 'website', 'nip05', 'lud16']) if (c[k]) p[k] = c[k];
      if (c.display_name && !p.name) p.name = c.display_name;
      // created_at is provenance *for the profile*: attach it only when the kind-0
      // actually contributes profile fields (not a bare timestamp object).
      if (Object.keys(p).length) {
        if (Number.isSafeInteger(profile.created_at)) p.created_at = profile.created_at;
        doc.profile = p;
      }
      if (Array.isArray(c.alsoKnownAs) && c.alsoKnownAs.length) doc.alsoKnownAs = c.alsoKnownAs;
    } catch { /* malformed kind-0 content */ }
  }

  // kind 3 -> follows (did:nostr of each followed key). Accept both the raw
  // kind-3 event ({tags:[["p",hex],…]}, what our indexer writes) and the
  // derived nostr-beacon shape ({follows:[hex,…], count}, from an imported dump).
  let followHexes = [];
  if (Array.isArray(follows?.tags)) {
    followHexes = follows.tags.filter((t) => t[0] === 'p').map((t) => t[1]);
  } else if (Array.isArray(follows?.follows)) {
    followHexes = follows.follows;
  }
  // Collect up to FOLLOWS_LIMIT valid entries and stop — avoids validating/mapping
  // the entire list (kind-3 events can carry thousands of tags) just to slice it.
  const f = [];
  for (const h of followHexes) {
    const lc = String(h).toLowerCase();
    if (!HEX64.test(lc)) continue;
    f.push(`did:nostr:${lc}`);
    if (f.length >= FOLLOWS_LIMIT) break;
  }
  if (f.length) doc.follows = f;

  // kind 10002 -> service (Relay)
  if (Array.isArray(relays?.tags)) {
    const svc = relays.tags
      .filter((t) => t[0] === 'r' && t[1])
      .map((t, i) => ({ id: `${did}#relay${i + 1}`, type: 'Relay', serviceEndpoint: t[1] }));
    if (svc.length) doc.service = svc;
  }

  // Subject provenance: max(created_at) over the signed parts actually composed
  // into the document, serialized ISO-8601. Representation-only changes are not
  // reflected here (those are conveyed by ETag / Last-Modified).
  const stamps = [
    // kind-0 composes the doc via profile and/or alsoKnownAs
    (doc.profile || doc.alsoKnownAs) && profile?.created_at,
    doc.follows && follows?.created_at,
    doc.service && relays?.created_at,
  ].filter(Number.isSafeInteger);
  if (stamps.length) {
    const iso = isoFromUnix(Math.max(...stamps));
    if (iso) doc.modified = iso;
  }

  return doc;
}
