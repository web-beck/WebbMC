'use strict';
// Your own domain for a playit.gg tunnel, through Cloudflare DNS. The panel works out the records the tunnel needs,
// shows what it would create, change or delete, and only touches DNS once an admin confirms. Needs
// CLOUDFLARE_API_TOKEN: a Cloudflare API token with Zone > DNS > Edit on the domain.
//
// Records for survival.example.com:
//   survival.example.com                 CNAME (or A)  the tunnel's real host, DNS only (Cloudflare's proxy cannot carry Minecraft)
//   _minecraft._tcp.survival.example.com SRV           0 5 <tunnel port> survival.example.com, so Java players need no port
const crypto = require('crypto');
const dns = require('dns');
const net = require('net');
const store = require('./store');
const { httpError } = require('./util');

const API = 'https://api.cloudflare.com/client/v4';
const COMMENT = 'Added by WebbMC for a playit.gg tunnel';
const RECORD_NOT_FOUND = 81044;
const token = () => (process.env.CLOUDFLARE_API_TOKEN || '').trim();
/** Saved links: { host, zoneId, destination, address, ids }. address is the tunnel address the records were made for. */
const links = () => (store.state.settings.cfDomains ||= []);

async function cf(method, path, body) {
  if (!token()) throw httpError(400, 'Add CLOUDFLARE_API_TOKEN on the .env tab and restart the panel first');
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    body: body && JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const j = await res.json().catch(() => ({}));
  if (!j.success) {
    const err = httpError(502, `Cloudflare: ${(j.errors || []).map((e) => e.message).join('; ') || `HTTP ${res.status}`}`);
    err.codes = (j.errors || []).map((e) => e.code);
    throw err;
  }
  return j.result;
}

function cleanHost(h) {
  const host = String(h || '').trim().toLowerCase().replace(/\.$/, '');
  if (host.length > 253 || !/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)) throw httpError(400, 'Enter a hostname like mc.example.com');
  return host;
}

async function zoneFor(host) {
  // shortcut: only the first 50 domains on the token are looked at, page through them if anyone has more.
  const zones = await cf('GET', '/zones?per_page=50');
  const zone = zones.filter((z) => host === z.name || host.endsWith(`.${z.name}`)).sort((a, b) => b.name.length - a.name.length)[0];
  if (!zone) throw httpError(400, `${host} is not on a domain this Cloudflare token can edit (it can edit: ${zones.map((z) => z.name).join(', ') || 'none'})`);
  return zone;
}

/** Where a playit address really goes. Addresses without a port lean on playit's own SRV record. */
async function resolveTunnel(address) {
  const m = /^(.+):(\d+)$/.exec(address);
  if (m) return { target: m[1], port: Number(m[2]) };
  const srv = await dns.promises.resolveSrv(`_minecraft._tcp.${address}`).catch(() => []);
  return srv[0] ? { target: srv[0].name.replace(/\.$/, ''), port: srv[0].port } : { target: address, port: 25565 };
}

const show = (r) => `${r.type} ${r.name} → ${r.type === 'SRV' ? `${r.data.priority} ${r.data.weight} ${r.data.port} ${r.data.target}` : r.content}${r.proxied ? ' (proxied)' : ''}`;
const sameSrv = (a, b) => ['priority', 'weight', 'port', 'target'].every((k) => String(a?.[k]).replace(/\.$/, '') === String(b[k]));

/** The two records a tunnel needs, as Cloudflare's API takes them. */
const want = (host, { target, port }) => [
  { type: net.isIPv4(target) ? 'A' : 'CNAME', name: host, content: target, proxied: false, ttl: 1, comment: COMMENT },
  { type: 'SRV', name: `_minecraft._tcp.${host}`, data: { priority: 0, weight: 5, port, target: host }, ttl: 1, comment: COMMENT },
];

/** The records to add by hand, at any DNS provider. Needs no Cloudflare token. */
async function records(rawHost, address) {
  const host = cleanHost(rawHost);
  const tunnel = await resolveTunnel(address);
  const [addr, srv] = want(host, tunnel);
  return {
    host,
    port: tunnel.port,
    records: [
      { type: addr.type, name: host, fields: [[addr.type === 'A' ? 'IPv4 address' : 'Target', addr.content], ['Proxy', 'DNS only (grey cloud)']] },
      { type: 'SRV', name: srv.name, fields: Object.entries({ Priority: 0, Weight: 5, Port: tunnel.port, Target: host }).map(([k, v]) => [k, String(v)]) },
    ],
  };
}

/**
 * The steps that make the records match (pure, so it can be tested). named: every record at host;
 * srvs: the SRV records at _minecraft._tcp.host. Deletes come first: a CNAME cannot be created next to an A.
 */
function diff(host, tunnel, named, srvs) {
  const [addr, srv] = want(host, tunnel);
  const { target } = tunnel;
  const others = named.filter((r) => !['A', 'AAAA', 'CNAME'].includes(r.type));
  if (addr.type === 'CNAME' && others.length) {
    throw httpError(409, `${host} already has ${others.map((r) => r.type).join(', ')} records, and a CNAME cannot sit next to them. Pick another name.`);
  }
  const steps = [];
  const sync = (want, existing, same) => {
    const keep = existing.find((r) => r.type === want.type);
    for (const r of existing) if (r !== keep) steps.push({ action: 'delete', id: r.id, text: show(r) });
    if (!keep) steps.push({ action: 'create', record: want, text: show(want) });
    else if (same(keep)) steps.push({ action: 'keep', id: keep.id, text: show(keep) });
    else steps.push({ action: 'update', id: keep.id, record: want, text: `${show(keep)}  ⟶  ${show(want)}` });
  };
  sync(addr, named.filter((r) => !others.includes(r)), (r) => r.content === target && !r.proxied);
  sync(srv, srvs, (r) => sameSrv(r.data, srv.data));
  return steps.sort((a, b) => (b.action === 'delete') - (a.action === 'delete'));
}

/** What pointing host at this tunnel would change. sig ties a confirmation to exactly this preview. */
async function plan(rawHost, address) {
  const host = cleanHost(rawHost);
  if (!address) throw httpError(400, 'This tunnel has no address yet');
  const [zone, tunnel] = await Promise.all([zoneFor(host), resolveTunnel(address)]);
  const q = (name, type = '') => cf('GET', `/zones/${zone.id}/dns_records?per_page=100&name=${encodeURIComponent(name)}${type && `&type=${type}`}`);
  const [named, srvs] = await Promise.all([q(host), q(`_minecraft._tcp.${host}`, 'SRV')]);
  const steps = diff(host, tunnel, named, srvs);
  const sig = crypto.createHash('sha1').update(JSON.stringify(steps)).digest('hex');
  return { host, zone: zone.name, zoneId: zone.id, address, ...tunnel, steps: steps.map((s) => ({ action: s.action, text: s.text })), sig, raw: steps };
}

const preview = async (host, address) => {
  const { raw, zoneId, ...p } = await plan(host, address);
  return p;
};

async function apply(rawHost, address, destination, sig, user) {
  const p = await plan(rawHost, address);
  if (sig !== p.sig) throw httpError(409, 'The DNS records changed since the preview. Look at the changes again.');
  const base = `/zones/${p.zoneId}/dns_records`;
  const ids = [];
  for (const s of p.raw) {
    if (s.action === 'delete') await cf('DELETE', `${base}/${s.id}`);
    else if (s.action === 'update') ids.push((await cf('PUT', `${base}/${s.id}`, s.record)).id);
    else if (s.action === 'create') ids.push((await cf('POST', base, s.record)).id);
    else ids.push(s.id);
  }
  store.state.settings.cfDomains = links().filter((l) => l.host !== p.host);
  links().push({ host: p.host, zoneId: p.zoneId, destination, address, ids });
  store.save();
  store.logActivity(null, `${user.id || 'An admin'} pointed ${p.host} at the playit.gg tunnel ${address} (Cloudflare DNS)`);
  return status();
}

/** Deletes the records the panel made for host (ones already gone are fine) and forgets the link. */
async function remove(rawHost, user) {
  const host = cleanHost(rawHost);
  const link = links().find((l) => l.host === host);
  if (!link) throw httpError(404, `${host} is not linked to a tunnel`);
  for (const id of link.ids) {
    await cf('DELETE', `/zones/${link.zoneId}/dns_records/${id}`).catch((err) => {
      if (!err.codes?.includes(RECORD_NOT_FOUND)) throw err;
    });
  }
  store.state.settings.cfDomains = links().filter((l) => l !== link);
  store.save();
  store.logActivity(null, `${user.id || 'An admin'} removed the Cloudflare DNS records for ${host}`);
  return status();
}

/** For the tunnels table: stale is worked out there, by comparing each link's address with the tunnel's address now. */
const status = () => ({ configured: Boolean(token()), domains: links().map(({ host, destination, address }) => ({ host, destination, address })) });

/** The domain linked to this tunnel, while its records still match the tunnel's address. */
const domainFor = (destination, address) => links().find((l) => l.destination === destination && l.address === address)?.host || '';

module.exports = { status, preview, apply, remove, records, domainFor, diff };
