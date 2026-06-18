// safeRelayUrl is the SSRF/format chokepoint for harvested relay URLs.
// Regression net for the relay-bomb incident (kind-10002 r-tag bombs full of
// loopback/private/.onion targets the prober would otherwise have dialed).
import test from 'node:test';
import assert from 'node:assert/strict';
import { safeRelayUrl, MAX_HARVEST_PER_EVENT } from '../src/hoses/relays.js';

test('accepts normal relays; canonicalizes bare origins', () => {
  assert.equal(safeRelayUrl('wss://relay.damus.io'), 'wss://relay.damus.io/');
  assert.equal(safeRelayUrl('wss://relay.damus.io/'), 'wss://relay.damus.io/');
  assert.equal(safeRelayUrl('wss://nos.lol/inbox'), 'wss://nos.lol/inbox');
  assert.equal(safeRelayUrl('ws://relay.example.com'), 'ws://relay.example.com/');
});

test('rejects loopback / localhost (would hit our own host)', () => {
  for (const u of ['wss://localhost', 'wss://localhost:3001', 'ws://127.0.0.1:4848/',
    'wss://app.localhost', 'wss://relay.local', 'wss://[::1]/', 'wss://0.0.0.0/']) {
    assert.equal(safeRelayUrl(u), null, u);
  }
});

test('rejects private / reserved / link-local ranges', () => {
  for (const u of ['ws://10.0.0.1:9173/', 'wss://192.168.1.5/', 'wss://172.16.0.1/',
    'wss://172.31.255.255/', 'wss://169.254.169.254/', 'wss://100.64.0.1/', 'wss://fe80::1/', 'wss://fc00::1/']) {
    assert.equal(safeRelayUrl(u), null, u);
  }
});

test('rejects all bare IP-literals (relays must use DNS names)', () => {
  assert.equal(safeRelayUrl('wss://8.8.8.8/'), null);     // public IP, still rejected
  assert.equal(safeRelayUrl('wss://1.2.3.4:7000/'), null);
});

test('rejects .onion (unreachable without Tor)', () => {
  assert.equal(safeRelayUrl('wss://abcdefghij234567.onion/'), null);
});

test('rejects malformed / double-scheme / non-ws', () => {
  for (const u of ['garbage', '', 'https://relay.example.com', 'wss://http://nostr-01.example.com',
    'wss://', 'wss://nodot', 'http://relay.example.com']) {
    assert.equal(safeRelayUrl(u), null, JSON.stringify(u));
  }
});

test('harvest cap is sane (bomb protection)', () => {
  assert.ok(MAX_HARVEST_PER_EVENT >= 1 && MAX_HARVEST_PER_EVENT <= 1000);
});
