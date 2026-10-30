'use strict';
// Xbox friends on the Server status page. Each account can connect a Microsoft account (device-code sign-in, like
// MCXboxBroadcast's own), see which friends are online, follow gamertags, and list the Minecraft Bedrock sessions
// those friends broadcast: what shows in Bedrock's Friends tab, so a broadcast account showing up here means it works.
// Needs XBOX_CLIENT_ID: an Azure app registration for personal Microsoft accounts with public client flows on.
const store = require('./store');
const { httpError } = require('./util');

const AUTHORITY = 'https://login.microsoftonline.com/consumers/oauth2/v2.0';
const SCOPE = 'XboxLive.signin offline_access';
const MC_SCID = '4fc10100-5f7a-4470-899b-280835760c07'; // Minecraft Bedrock's service config, where its sessions live
const XSTS_ERRORS = {
  2148916233: 'This Microsoft account has no Xbox profile yet. Sign in once at xbox.com to make one, then connect again.',
  2148916235: 'Xbox Live is not available in this account’s country.',
  2148916238: 'This is a child account. An adult must add it to a Microsoft family first.',
};

const clientId = () => (process.env.XBOX_CLIENT_ID || '').trim();
const record = (id) => store.state.users.find((u) => u.id === id);
const pending = new Map(); // account id -> { deviceCode, code, uri, expiresAt, interval, nextPoll }
const tokens = new Map(); // account id -> { auth, xuid, gamertag, expiresAt }, kept in memory only

/** Microsoft's error text without the trace ids it appends. */
const msError = (data) => String(data.error_description || data.error || 'Microsoft sign-in failed').split(/\r?\n| Trace ID:/)[0];

async function postForm(url, form) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form), signal: AbortSignal.timeout(15000) });
  return { ok: res.ok, data: await res.json().catch(() => ({})) };
}

async function postXbox(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'x-xbl-contract-version': '1' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw httpError(400, XSTS_ERRORS[data.XErr] || `Xbox Live sign-in failed (${res.status}${data.XErr ? `, error ${data.XErr}` : ''})`);
  return data;
}

/** Microsoft access token -> Xbox Live user token -> XSTS token for the Xbox web APIs. */
async function xboxTokens(msAccess) {
  const user = await postXbox('https://user.auth.xboxlive.com/user/authenticate', {
    Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: `d=${msAccess}` },
    RelyingParty: 'http://auth.xboxlive.com',
    TokenType: 'JWT',
  });
  const xsts = await postXbox('https://xsts.auth.xboxlive.com/xsts/authorize', {
    Properties: { SandboxId: 'RETAIL', UserTokens: [user.Token] },
    RelyingParty: 'http://xboxlive.com',
    TokenType: 'JWT',
  });
  const claims = xsts.DisplayClaims?.xui?.[0] || {};
  return { auth: `XBL3.0 x=${claims.uhs};${xsts.Token}`, xuid: claims.xid, gamertag: claims.gtg, expiresAt: Date.parse(xsts.NotAfter) || Date.now() + 3600e3 };
}

/** Keeps the refresh token (the only lasting secret) on the account record; userView never sends it to pages. */
async function keep(u, msData) {
  const t = await xboxTokens(msData.access_token);
  u.xbox = { refresh: msData.refresh_token || u.xbox?.refresh, xuid: t.xuid, gamertag: t.gamertag, since: u.xbox?.since || Date.now() };
  tokens.set(u.id, t);
  store.save();
  return t;
}

async function session(id) {
  const cached = tokens.get(id);
  if (cached && cached.expiresAt - Date.now() > 60e3) return cached;
  const u = record(id);
  if (!u?.xbox) throw httpError(400, 'Connect a Microsoft account first');
  const { ok, data } = await postForm(`${AUTHORITY}/token`, { client_id: clientId(), grant_type: 'refresh_token', refresh_token: u.xbox.refresh, scope: SCOPE });
  if (!ok) {
    if (data.error !== 'invalid_grant') throw httpError(502, msError(data));
    delete u.xbox;
    store.save();
    throw httpError(400, 'Microsoft ended this sign-in (password changed, or access removed). Connect your account again.');
  }
  return keep(u, data);
}

/** For the page. While a sign-in is waiting, each call also asks Microsoft once whether it finished. */
async function status(user) {
  const u = record(user.id);
  const base = () => ({ configured: Boolean(clientId()), connected: Boolean(u?.xbox), gamertag: u?.xbox?.gamertag || null, xuid: u?.xbox?.xuid || null });
  const p = pending.get(user.id);
  if (!p || !u) return base();
  if (Date.now() > p.expiresAt) {
    pending.delete(user.id);
    return { ...base(), error: 'The code expired. Press Connect to get a new one.' };
  }
  if (Date.now() >= p.nextPoll) {
    p.nextPoll = Date.now() + p.interval * 1000;
    try {
      const { ok, data } = await postForm(`${AUTHORITY}/token`, { client_id: clientId(), grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: p.deviceCode });
      if (ok) {
        pending.delete(user.id);
        await keep(u, data);
        store.logActivity(null, `${user.name} connected the Xbox account ${u.xbox.gamertag}`);
        return base();
      }
      if (data.error === 'slow_down') p.interval += 5;
      else if (data.error !== 'authorization_pending') {
        pending.delete(user.id);
        return { ...base(), error: data.error === 'authorization_declined' ? 'Sign-in was cancelled.' : msError(data) };
      }
    } catch (err) {
      pending.delete(user.id);
      return { ...base(), error: err.message };
    }
  }
  return { ...base(), pending: { code: p.code, uri: p.uri, expiresAt: p.expiresAt } };
}

async function connect(user) {
  if (!clientId()) throw httpError(400, 'Set XBOX_CLIENT_ID first (Panel settings → .env). The README explains how to get one.');
  const { ok, data } = await postForm(`${AUTHORITY}/devicecode`, { client_id: clientId(), scope: SCOPE });
  if (!ok) throw httpError(502, msError(data));
  pending.set(user.id, {
    deviceCode: data.device_code,
    code: data.user_code,
    uri: data.verification_uri,
    expiresAt: Date.now() + data.expires_in * 1000,
    interval: data.interval ?? 5,
    nextPoll: Date.now() + (data.interval ?? 5) * 1000,
  });
  return status(user);
}

/** Forgets the sign-in here. Microsoft keeps the app's consent until it is removed at account.live.com/consent/Manage. */
function disconnect(user) {
  pending.delete(user.id);
  tokens.delete(user.id);
  const u = record(user.id);
  if (u?.xbox) {
    delete u.xbox;
    store.save();
  }
  return status(user);
}

async function xbl(user, url, { method = 'GET', body, version, notFound } = {}) {
  const t = await session(user.id);
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: t.auth,
      Accept: 'application/json',
      'Accept-Language': 'en-US',
      ...(version ? { 'x-xbl-contract-version': String(version) } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  if (res.status === 401) tokens.delete(user.id); // signed in again on the next call
  if (res.status === 404 && notFound) throw httpError(404, notFound);
  if (!res.ok) throw httpError(502, `Xbox Live answered ${res.status} ${res.statusText}`.trim());
  return { t, data: await res.json().catch(() => null) };
}

/** People this account follows (with presence), and the Minecraft sessions they host. */
async function friends(user) {
  const { t, data } = await xbl(user, 'https://peoplehub.xboxlive.com/users/me/people/social/decoration/presencedetail', { version: 5 });
  const people = (data?.people || [])
    .map((p) => ({
      xuid: p.xuid,
      gamertag: p.modernGamertag || p.gamertag,
      picture: p.displayPicRaw || '',
      online: p.presenceState === 'Online',
      presence: p.presenceText || '',
      mutual: Boolean(p.isFollowingCaller),
    }))
    .sort((a, b) => b.online - a.online || a.gamertag.localeCompare(b.gamertag));
  let sessions = [];
  let sessionsError = null;
  try {
    const { data: s } = await xbl(user, 'https://sessiondirectory.xboxlive.com/handles/query?include=relatedInfo,customProperties', {
      method: 'POST',
      version: 107,
      body: { type: 'activity', scid: MC_SCID, owners: { people: { moniker: 'people', monikerXuid: t.xuid } } },
    });
    const names = new Map(people.map((p) => [p.xuid, p.gamertag]));
    sessions = (s?.results || []).map((r) => {
      const c = r.customProperties || {};
      return {
        xuid: r.ownerXuid,
        gamertag: names.get(r.ownerXuid) || r.ownerXuid,
        host: c.hostName || '',
        world: c.worldName || '',
        version: c.version || '',
        players: c.MemberCount ?? r.relatedInfo?.membersCount ?? null,
        max: c.MaxMemberCount ?? r.relatedInfo?.maxMembersCount ?? null,
        closed: Boolean(r.relatedInfo?.closed),
      };
    });
  } catch (err) {
    sessionsError = err.message; // the friends list is still useful without it
  }
  return { gamertag: t.gamertag, people, sessions, sessionsError };
}

const GAMERTAG_RE = /^[A-Za-z0-9 ]{1,16}(#\d{1,4})?$/;

async function follow(user, gamertagIn) {
  const gamertag = String(gamertagIn || '').trim();
  if (!GAMERTAG_RE.test(gamertag)) throw httpError(400, 'Enter a gamertag (letters, digits and spaces, with an optional #1234 suffix)');
  const { data } = await xbl(user, `https://profile.xboxlive.com/users/gt(${encodeURIComponent(gamertag)})/profile/settings?settings=Gamertag`, {
    version: 2,
    notFound: `No Xbox account has the gamertag ${gamertag}`,
  });
  const xuid = data?.profileUsers?.[0]?.id;
  if (!xuid) throw httpError(404, `No Xbox account has the gamertag ${gamertag}`);
  await xbl(user, `https://social.xboxlive.com/users/me/people/xuid(${xuid})`, { method: 'PUT' });
  return friends(user);
}

async function unfollow(user, xuidIn) {
  const xuid = String(xuidIn || '');
  if (!/^\d{1,20}$/.test(xuid)) throw httpError(400, 'Invalid Xbox user id');
  await xbl(user, `https://social.xboxlive.com/users/me/people/xuid(${xuid})`, { method: 'DELETE' });
  return friends(user);
}

module.exports = { status, connect, disconnect, friends, follow, unfollow };
