'use strict';
// The bell in the top bar: panel updates and accounts waiting for approval (admins), crashes and failures on the
// servers you can see, and servers shared with you. Read state is one "seen up to" time per account.
const store = require('./store');
const auth = require('./auth');
const updates = require('./updates');

const MAX_AGE = 14 * 24 * 60 * 60 * 1000;
const MAX_ITEMS = 40;

/** visibleIds: ids of the servers this account can see. */
function list(user, visibleIds) {
  const items = [];
  if (user.admin) {
    const u = updates.status();
    if (u.available) {
      items.push({
        id: `update-${u.commits[0]?.sha || ''}`,
        kind: 'update',
        t: u.foundAt || u.checkedAt,
        title: 'A panel update is available',
        text: `${u.behind} new change${u.behind === 1 ? '' : 's'}${u.commits[0] ? `, latest: ${u.commits[0].subject}` : ''}`,
        href: '#/settings/updates',
        canApply: u.canApply,
      });
    }
    const pending = auth.pendingUsers();
    if (pending.length) {
      items.push({
        id: 'pending',
        kind: 'accounts',
        t: Math.max(...pending.map((p) => p.firstSeen || 0)),
        title: `${pending.length} account${pending.length === 1 ? '' : 's'} waiting for approval`,
        text: pending.map((p) => p.id).slice(0, 5).join(', '),
        href: '#/settings',
      });
    }
  }
  const since = Date.now() - MAX_AGE;
  for (const a of store.state.activity) {
    if (a.t < since || items.length >= MAX_ITEMS) break;
    const forMe = user.id && a.to === user.id;
    const problem = a.level === 'error' && (a.serverId ? visibleIds.has(a.serverId) : user.admin);
    if (!forMe && !problem) continue;
    items.push({
      id: `a-${a.t}-${a.serverId || ''}`,
      kind: problem ? 'error' : 'share',
      t: a.t,
      title: a.message,
      serverId: a.serverId || null,
      href: a.serverId && visibleIds.has(a.serverId) ? `#/server/${a.serverId}` : '#/activity',
    });
  }
  const seen = auth.notifSeen(user);
  for (const i of items) i.unread = i.t > seen;
  return { items, unread: items.filter((i) => i.unread).length };
}

module.exports = { list };
