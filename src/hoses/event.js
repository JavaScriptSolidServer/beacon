// Shared Nostr event verification used by every hose.
//
// A hose layers kind- and content-specific rules on top of this: the checks
// here are common to all events — well-formed pubkey/created_at/sig, an `id`
// that matches the canonical serialization, and a valid schnorr signature.
import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js';

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;
const enc = new TextEncoder();

// NIP-01 event id: sha256 of [0, pubkey, created_at, kind, tags, content].
export function eventId(e) {
  const serial = JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags || [], e.content ?? '']);
  return bytesToHex(sha256(enc.encode(serial)));
}

/**
 * Structural + cryptographic validation common to every event. Verifies the
 * pubkey/created_at/sig are well-formed, the claimed `id` (if present) matches
 * the content, and the schnorr signature checks out. Does NOT inspect `kind`
 * or content semantics — callers add those.
 */
export function verifySignature(e) {
  if (!e || typeof e.pubkey !== 'string' || !HEX64.test(e.pubkey)) return false;
  if (!Number.isFinite(e.created_at)) return false;
  if (typeof e.sig !== 'string' || !HEX128.test(e.sig)) return false;
  const id = eventId(e);
  if (e.id && e.id !== id) return false; // claimed id must match the content
  try { return schnorr.verify(hexToBytes(e.sig), hexToBytes(id), hexToBytes(e.pubkey)); }
  catch { return false; }
}
