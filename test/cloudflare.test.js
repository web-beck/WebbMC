'use strict';
// Run with: node --test test/cloudflare.test.js
const test = require('node:test');
const assert = require('node:assert');
const { diff } = require('../lib/cloudflare');

const host = 'mc.example.com';
const tunnel = { target: 'abc.ply.gg', port: 12345 };
const srv = (port, target = host) => ({ id: 's1', type: 'SRV', name: `_minecraft._tcp.${host}`, data: { priority: 0, weight: 5, port, target } });
const actions = (steps) => steps.map((s) => `${s.action}${s.record ? ` ${s.record.type}` : ''}`);

test('fresh name gets a CNAME and an SRV', () => {
  assert.deepStrictEqual(actions(diff(host, tunnel, [], [])), ['create CNAME', 'create SRV']);
});

test('matching records are kept', () => {
  const steps = diff(host, tunnel, [{ id: 'c1', type: 'CNAME', name: host, content: 'abc.ply.gg', proxied: false }], [srv(12345)]);
  assert.deepStrictEqual(actions(steps), ['keep', 'keep']);
});

test('a proxied CNAME and an old port are updated', () => {
  const steps = diff(host, tunnel, [{ id: 'c1', type: 'CNAME', name: host, content: 'abc.ply.gg', proxied: true }], [srv(1)]);
  assert.deepStrictEqual(actions(steps), ['update CNAME', 'update SRV']);
});

test('an A record is deleted before the CNAME is created', () => {
  const steps = diff(host, tunnel, [{ id: 'a1', type: 'A', name: host, content: '1.2.3.4' }], []);
  assert.deepStrictEqual(actions(steps), ['delete', 'create CNAME', 'create SRV']);
});

test('an IP tunnel gets an A record', () => {
  assert.deepStrictEqual(actions(diff(host, { target: '147.185.221.1', port: 5 }, [], [])), ['create A', 'create SRV']);
});

test('a CNAME refuses to replace TXT or MX records', () => {
  assert.throws(() => diff(host, tunnel, [{ id: 't1', type: 'TXT', name: host, content: 'x' }], []), /cannot sit next to them/);
});

const { formatRecords } = require('../lib/cloudflare');
const fields = (host, provider, t = tunnel) => formatRecords(host, t, provider).records.map((r) => [r.type, Object.fromEntries(r.fields)]);

test('Squarespace gets short names (the doubled-name mistake)', () => {
  const [[type, a], [, srv]] = fields('mc.inclusionarcade.ca', 'squarespace', { target: '69.9.180.16', port: 57464 });
  assert.strictEqual(type, 'A');
  assert.deepStrictEqual(a, { Name: 'mc', Data: '69.9.180.16' });
  assert.deepStrictEqual(srv, { Name: '_minecraft._tcp.mc', Priority: '0', Weight: '5', Port: '57464', Target: 'mc.inclusionarcade.ca' });
});

test('GoDaddy splits Service, Protocol and Name', () => {
  const [, [, srv]] = fields(host, 'godaddy');
  assert.deepStrictEqual(srv, { Service: '_minecraft', Protocol: '_tcp', Name: 'mc', Priority: '0', Weight: '5', Port: '12345', Target: host });
});

test('Namecheap puts the subdomain in Protocol', () => {
  assert.strictEqual(fields('play.example.com', 'namecheap')[1][1].Protocol, '_tcp.play');
});

test('Porkbun and Route 53 combine parts into one value', () => {
  assert.strictEqual(fields(host, 'porkbun')[1][1].Answer, `5 12345 ${host}`);
  assert.strictEqual(fields(host, 'route53')[1][1].Value, `0 5 12345 ${host}`);
});

test('two-part endings and the root domain', () => {
  assert.strictEqual(formatRecords('mc.example.co.uk', tunnel, 'godaddy').zone, 'example.co.uk');
  const root = formatRecords('example.com', tunnel, 'godaddy');
  assert.strictEqual(Object.fromEntries(root.records[0].fields).Name, '@');
  assert.match(root.notes[0], /root domain/);
});
