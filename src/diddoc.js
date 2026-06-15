// Build a spec-conformant did:nostr DID document from indexed events.
//
// Implements the current spec (https://nostrcg.github.io/did-nostr/):
//   - @context: cid/v1 + nostr/context   (cf. nostrcg/did-nostr#90/#91)
//   - type: DIDNostr
//   - Multikey VM with publicKeyMultibase = f + e701 + 02 + <x-only hex>
//   - enhanced: profile (kind 0), follows (kind 3), service/Relay (kind 10002)
//
// Per RFC JavaScriptSolidServer/JavaScriptSolidServer#572 this is intended to
// converge with jss's shared `buildDidDocument` once that is extracted as a
// reusable module; until then beacon builds the conformant doc directly so it
// is correct now (and avoids the divergent-generator bugs of nostr-labs/nostr-beacon#3).

const HEX64 = /^[0-9a-f]{64}$/;

export function buildDidDocument(pubkey, { profile, follows, relays } = {}) {
  const hex = String(pubkey || '').toLowerCase();
  if (!HEX64.test(hex)) return null;
  const did = `did:nostr:${hex}`;

  const doc = {
    '@context': ['https://www.w3.org/ns/cid/v1', 'https://w3id.org/nostr/context'],
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
      if (profile.created_at) p.timestamp = profile.created_at;
      if (Object.keys(p).length) doc.profile = p;
      if (Array.isArray(c.alsoKnownAs) && c.alsoKnownAs.length) doc.alsoKnownAs = c.alsoKnownAs;
    } catch { /* malformed kind-0 content */ }
  }

  // kind 3 -> follows (did:nostr of each p-tag)
  if (Array.isArray(follows?.tags)) {
    const f = follows.tags
      .filter((t) => t[0] === 'p' && HEX64.test(String(t[1]).toLowerCase()))
      .map((t) => `did:nostr:${String(t[1]).toLowerCase()}`);
    if (f.length) doc.follows = f;
  }

  // kind 10002 -> service (Relay)
  if (Array.isArray(relays?.tags)) {
    const svc = relays.tags
      .filter((t) => t[0] === 'r' && t[1])
      .map((t, i) => ({ id: `${did}#relay${i + 1}`, type: 'Relay', serviceEndpoint: t[1] }));
    if (svc.length) doc.service = svc;
  }

  return doc;
}
