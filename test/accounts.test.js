'use strict';
// Run with: node --test test/accounts.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.WEBMC_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'webbmc-test-'));
const store = require('../lib/store');
const auth = require('../lib/auth');

store.state.users.push(
  { id: 'gryddz', username: 'gryddz', name: 'Gryddz', status: 'approved', firstSeen: 1 },
  { id: 'grace@example.com', name: 'Grace', status: 'approved', google: { sub: '1', email: 'grace@example.com' }, firstSeen: 1 },
  { id: 'grblocked', username: 'grblocked', name: 'X', status: 'blocked', firstSeen: 1 },
  { id: 'me', username: 'me', name: 'Me', status: 'approved', firstSeen: 1 },
);
const me = { id: 'me' };

test('search: usernames only for non-admins, needs 2 letters, skips blocked and self', () => {
  assert.deepStrictEqual(auth.searchUsers(me, 'g'), []);
  assert.deepStrictEqual(auth.searchUsers(me, 'GR').map((u) => u.id), ['gryddz']);
  assert.deepStrictEqual(auth.searchUsers({ id: 'x', admin: true }, 'gr').map((u) => u.id), ['gryddz', 'grace@example.com']);
  assert.deepStrictEqual(auth.searchUsers(me, 'me'), []);
});

test('picture: accepts a small data URL, rejects others, clears with empty', () => {
  const res = { setHeader() {} };
  const ok = 'data:image/webp;base64,AAAA';
  assert.strictEqual(auth.updateAccount(null, res, me, { picture: ok }).picture, ok);
  assert.throws(() => auth.updateAccount(null, res, me, { picture: 'https://evil.example/x.png' }), /not valid/);
  assert.throws(() => auth.updateAccount(null, res, me, { picture: 'data:image/svg+xml;base64,AAAA' }), /not valid/);
  assert.throws(() => auth.updateAccount(null, res, me, { picture: `data:image/png;base64,${'A'.repeat(100_000)}` }), /too big/);
  assert.strictEqual(auth.updateAccount(null, res, me, { picture: '' }).picture, '');
});
