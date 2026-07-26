// Unit tests for the /relays data island (issue #45).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relaysIslandHtml } from '../src/server.js';

const dir = {
  counts: { all: 3, online: 2, public: 1, paid: 0, auth: 0 },
  lastChecked: '2026-07-26T17:02:47.459Z',
  relays: [
    { relay: 'wss://nos.lol/', online: true, responseTime: 49, uptime: 100 },
  ],
};

test('island is a parseable application/json script with typed Relay objects', () => {
  const html = relaysIslandHtml(dir, 'https://nostr.social');
  assert.match(html, /^<script type="application\/json" id="relays-data">/);
  const json = html.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '');
  const data = JSON.parse(json);
  assert.equal(data['@context'], 'https://w3id.org/nostr/context');
  assert.equal(data.id, 'https://nostr.social/relays');
  assert.deepEqual(data.counts, dir.counts);
  assert.equal(data.relays[0].type, 'Relay');
  assert.equal(data.relays[0].relay, 'wss://nos.lol/');
});

test('hostile relay URL cannot break out of the script element', () => {
  const evil = { ...dir, relays: [{ relay: 'wss://x/</script><script>alert(1)</script>', online: false }] };
  const html = relaysIslandHtml(evil, 'https://nostr.social');
  // exactly one script open and one close tag: the island's own
  assert.equal((html.match(/<\/script>/g) || []).length, 1);
  assert.equal((html.match(/<script/g) || []).length, 1);
  // and the payload still round-trips with the URL intact
  const data = JSON.parse(html.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, ''));
  assert.equal(data.relays[0].relay, 'wss://x/</script><script>alert(1)</script>');
});

test('empty directory produces a valid island', () => {
  const html = relaysIslandHtml({ counts: {}, lastChecked: null, relays: [] }, 'https://nostr.social');
  const data = JSON.parse(html.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, ''));
  assert.deepEqual(data.relays, []);
});
