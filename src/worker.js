// MiningLedger: Cloudflare Worker.
//   * scheduled(): every 10 min reads each character's ESI mining ledger; hourly refreshes Jita ice prices
//   * /auth/*:     EVE SSO login (PKCE, no client secret). One account per main; alts are added while logged in
//   * /api/*:      the logged-in account's characters, mining, prices and settings (never anyone else's)
//   * everything else: static files in /public
import { ensureSchema, getMeta, setMeta } from './db.js';
import { scheduled, pollDue, refreshPrices } from './poll.js';
import { verifyEveToken } from './jwt.js';
import { encrypt, jwtExp, tokenRequest } from './tokens.js';
import { DEFAULT_SETTINGS, DEFAULT_COMPARE, ICE, PRICED, PRODUCTS, PRICE_SOURCES, POLL_MINUTES } from '../public/ice.js';

const SSO = 'https://login.eveonline.com/v2/oauth';
const SCOPE = 'esi-industry.read_character_mining.v1';
const SESSION_DAYS = 30;
const MAX_CHARACTERS = 30;

// ---------------------------------------------------------------- helpers
const json = (data, status = 200, headers = {}) => new Response(typeof data === 'string' ? data : JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
});
const fail = (status, error) => json({ error }, status);
const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const randomId = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));
const cookies = req => Object.fromEntries((req.headers.get('Cookie') || '').split(/;\s*/).filter(Boolean).map(c => { const i = c.indexOf('='); return [c.slice(0, i), decodeURIComponent(c.slice(i + 1))]; }));
const cookie = (name, value, { maxAge, path = '/' } = {}) =>
  `${name}=${encodeURIComponent(value)}; Path=${path}; HttpOnly; Secure; SameSite=Lax${maxAge != null ? `; Max-Age=${maxAge}` : ''}`;
const redirect = (to, setCookies = []) => {
  const h = new Headers({ Location: to, 'Cache-Control': 'no-store' });
  for (const c of setCookies) h.append('Set-Cookie', c);
  return new Response(null, { status: 302, headers: h });
};
const settingsOf = acc => {
  const s = { ...DEFAULT_SETTINGS, ...JSON.parse(acc.settings || '{}') };
  s.compare = { ...DEFAULT_COMPARE, ...(s.compare || {}) };
  return s;
};

async function currentAccount(req, env) {
  const sid = cookies(req).ml_sess;
  if (!sid) return null;
  const row = await env.DB.prepare(`SELECT a.id, a.main_character_id, a.settings, l.expires FROM logins l JOIN accounts a ON a.id = l.account_id WHERE l.id = ?`).bind(sid).first();
  if (!row || row.expires < Date.now()) return null;
  return { ...row, sid };
}

// ---------------------------------------------------------------- auth
const callbackUrl = (req, env) => env.EVE_CALLBACK_URL || `${new URL(req.url).origin}/auth/callback`;

async function authLogin(req, env) {
  if (!env.EVE_CLIENT_ID) return new Response('EVE_CLIENT_ID is not set in wrangler.toml', { status: 500 });
  const mode = new URL(req.url).searchParams.get('add') ? 'add' : 'login';
  const verifier = randomId(32);
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const state = randomId(16);
  const p = new URLSearchParams({
    response_type: 'code', redirect_uri: callbackUrl(req, env), client_id: env.EVE_CLIENT_ID, scope: SCOPE,
    code_challenge: challenge, code_challenge_method: 'S256', state,
  });
  return redirect(`${SSO}/authorize?${p}`, [cookie('ml_oauth', `${state}.${verifier}.${mode}`, { maxAge: 600, path: '/auth' })]);
}

async function authCallback(req, env, fetchImpl = fetch) {
  const url = new URL(req.url);
  const db = env.DB;
  const clear = cookie('ml_oauth', '', { maxAge: 0, path: '/auth' });
  const [state, verifier, mode] = (cookies(req).ml_oauth || '').split('.');
  const back = msg => redirect(`/?msg=${encodeURIComponent(msg)}`, [clear]);
  if (url.searchParams.get('error') || !state || state !== url.searchParams.get('state')) return back('EVE login was cancelled or expired. Try again.');
  try {
    const tok = await tokenRequest(env, { grant_type: 'authorization_code', code: url.searchParams.get('code') || '', code_verifier: verifier }, fetchImpl);
    const who = await verifyEveToken(tok.access_token, { CLIENT_ID: env.EVE_CLIENT_ID }, fetchImpl);
    if (!who.scopes.includes(SCOPE)) return back('EVE did not grant access to the mining ledger. Log in again and leave the permission ticked.');
    const enc = await encrypt(env, tok.refresh_token);
    const now = Date.now();
    const existing = await db.prepare('SELECT account_id FROM characters WHERE character_id = ?').bind(who.id).first();
    const me = await currentAccount(req, env);
    let accountId, note = null;

    if (mode === 'add') {
      if (!me) return back('Your session ended. Log in with your main first, then add alts.');
      if (existing && existing.account_id !== me.id) return back(`${who.name} is already linked to a different MiningLedger account, so it was not added. Log in as that account and remove it there first.`);
      const n = await db.prepare('SELECT COUNT(*) AS n FROM characters WHERE account_id = ?').bind(me.id).first();
      if (!existing && n.n >= MAX_CHARACTERS) return back(`Character limit (${MAX_CHARACTERS}) reached.`);
      accountId = me.id;
      note = existing ? `${who.name} logged in again.` : `${who.name} added. Mining history from the last 30 days is loading.`;
    } else if (existing) {
      accountId = existing.account_id; // an alt logs straight into the account it belongs to
    } else {
      const r = await db.prepare('INSERT INTO accounts (main_character_id, settings, created_at) VALUES (?, ?, ?) RETURNING id').bind(who.id, JSON.stringify(DEFAULT_SETTINGS), now).first();
      accountId = r.id;
    }

    const sid = me && me.id === accountId ? me.sid : randomId(32);
    const ops = [
      db.prepare(`INSERT INTO characters (character_id, account_id, name, refresh_enc, access_token, access_exp, needs_login, added_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)
        ON CONFLICT(character_id) DO UPDATE SET name = excluded.name, refresh_enc = excluded.refresh_enc, access_token = excluded.access_token,
        access_exp = excluded.access_exp, needs_login = 0, last_error = NULL`)
        .bind(who.id, accountId, who.name, enc, tok.access_token, jwtExp(tok.access_token), now),
    ];
    if (sid !== me?.sid) ops.push(db.prepare('INSERT INTO logins (id, account_id, expires) VALUES (?, ?, ?)').bind(sid, accountId, now + SESSION_DAYS * 86400e3));
    await db.batch(ops);
    return redirect(note ? `/?msg=${encodeURIComponent(note)}` : '/', [clear, cookie('ml_sess', sid, { maxAge: SESSION_DAYS * 86400 })]);
  } catch (e) {
    console.error('login failed', e);
    return back(e.status === 503 ? e.message : 'EVE login failed. Try again in a minute.');
  }
}

async function authLogout(req, env) {
  const a = await currentAccount(req, env);
  if (a) await env.DB.prepare('DELETE FROM logins WHERE id = ?').bind(a.sid).run();
  return redirect('/', [cookie('ml_sess', '', { maxAge: 0 })]);
}

// ---------------------------------------------------------------- api
async function api(req, env, path, fetchImpl) {
  const db = env.DB;
  const m = req.method;
  const q = new URL(req.url).searchParams;

  if (path === '/api/prices' && m === 'GET') {
    // Fresh database (or new price types added): fetch prices now rather than waiting for the hourly schedule (at most every 2 minutes).
    const have = await db.prepare('SELECT COUNT(*) AS n FROM prices').first();
    if (!(await getMeta(db, 'prices_updated')) || have.n < Object.keys(PRICED).length + Object.keys(PRODUCTS).length) {
      const tried = Number(await getMeta(db, 'prices_try') || 0);
      if (Date.now() - tried > 2 * 60e3) { await setMeta(db, 'prices_try', Date.now()).run(); await refreshPrices(env, fetchImpl); }
    }
    const { results } = await db.prepare('SELECT type_id, buy, sell, note, updated FROM prices').all();
    return json({ updated: Number(await getMeta(db, 'prices_updated')) || null, prices: Object.fromEntries(results.map(r => [r.type_id, r])) }, 200, { 'Cache-Control': 'public, max-age=300' });
  }

  const acc = await currentAccount(req, env);
  if (path === '/api/me' && m === 'GET') {
    if (!acc) return json({ logged_in: false });
    const { results } = await db.prepare('SELECT character_id, name, needs_login, added_at, last_poll, last_error FROM characters WHERE account_id = ? ORDER BY character_id = ? DESC, name')
      .bind(acc.id, acc.main_character_id).all();
    const last = await getMeta(db, 'last_poll_run');
    return json({
      logged_in: true, main_character_id: acc.main_character_id, settings: settingsOf(acc), price_sources: PRICE_SOURCES, poll_minutes: POLL_MINUTES,
      characters: results.map(c => ({ ...c, needs_login: !!c.needs_login, is_main: c.character_id === acc.main_character_id })),
      last_poll_run: last ? JSON.parse(last) : null,
    });
  }
  if (!acc) return fail(401, 'Log in with EVE first');

  // Mining entries for this account's characters only. ?from= / ?to= are ms timestamps.
  if (path === '/api/events' && m === 'GET') {
    const from = Number(q.get('from')) || Date.now() - 30 * 86400e3, to = Number(q.get('to')) || Date.now() + 86400e3;
    const { results } = await db.prepare(`SELECT e.character_id AS c, e.at AS t, e.date AS d, e.solar_system_id AS s, e.type_id AS y, e.quantity AS q, e.approx AS a
      FROM mining_events e JOIN characters ch ON ch.character_id = e.character_id WHERE ch.account_id = ? AND e.at >= ? AND e.at < ? ORDER BY e.at LIMIT 50000`).bind(acc.id, from, to).all();
    return json(results);
  }

  // All-time units by character and ice type (cheap, so the all-time total never needs every entry).
  if (path === '/api/totals' && m === 'GET') {
    const { results } = await db.prepare(`SELECT e.character_id AS c, e.type_id AS y, SUM(e.quantity) AS q, MIN(e.date) AS first
      FROM mining_events e JOIN characters ch ON ch.character_id = e.character_id WHERE ch.account_id = ? GROUP BY e.character_id, e.type_id`).bind(acc.id).all();
    return json(results);
  }

  if (path === '/api/settings' && m === 'PUT') {
    let b = {};
    try { b = await req.json(); } catch { return fail(400, 'Bad request'); }
    const s = settingsOf(acc);
    if (b.price_source !== undefined) { if (!PRICE_SOURCES.includes(b.price_source)) return fail(400, 'Unknown price source'); s.price_source = b.price_source; }
    if (b.percentage !== undefined) { const p = Number(b.percentage); if (!(p > 0 && p <= 200)) return fail(400, 'Percentage must be between 1 and 200'); s.percentage = Math.round(p * 10) / 10; }
    if (b.session_gap_minutes !== undefined) { const g = Number(b.session_gap_minutes); if (!(g >= 15 && g <= 240)) return fail(400, 'Session gap must be 15 to 240 minutes'); s.session_gap_minutes = Math.round(g); }
    if (b.compare !== undefined) {
      const c = b.compare || {}, cur = s.compare;
      if (c.enabled !== undefined) cur.enabled = !!c.enabled;
      if (c.name !== undefined) cur.name = String(c.name).trim().slice(0, 40) || DEFAULT_COMPARE.name;
      if (c.short !== undefined) cur.short = String(c.short).trim().slice(0, 8) || DEFAULT_COMPARE.short;
      if (c.percentage !== undefined) { const p = Number(c.percentage); if (!(p > 0 && p <= 200)) return fail(400, 'Buyback percentage must be between 1 and 200'); cur.percentage = Math.round(p * 10) / 10; }
      if (c.yield !== undefined) { const y = Number(c.yield); if (!(y >= 50 && y <= 100)) return fail(400, 'Refine yield must be between 50 and 100'); cur.yield = Math.round(y * 100) / 100; }
      if (c.accepted !== undefined) { if (!Array.isArray(c.accepted)) return fail(400, 'Bad accepted list'); cur.accepted = [...new Set(c.accepted.map(Number).filter(id => ICE[id]))]; }
    }
    await db.prepare('UPDATE accounts SET settings = ? WHERE id = ?').bind(JSON.stringify(s), acc.id).run();
    return json({ settings: s });
  }

  const ch = path.match(/^\/api\/characters\/(\d+)(\/main)?$/);
  if (ch) {
    const id = Number(ch[1]);
    const row = await db.prepare('SELECT character_id FROM characters WHERE character_id = ? AND account_id = ?').bind(id, acc.id).first();
    if (!row) return fail(404, 'That character is not on your account');
    if (ch[2] && m === 'POST') {
      await db.prepare('UPDATE accounts SET main_character_id = ? WHERE id = ?').bind(id, acc.id).run();
      return json({ ok: true });
    }
    if (!ch[2] && m === 'DELETE') {
      if (id === acc.main_character_id) return fail(400, 'Make another character the main before removing this one');
      await db.batch([
        db.prepare('DELETE FROM mining_events WHERE character_id = ?').bind(id),
        db.prepare('DELETE FROM ledger_totals WHERE character_id = ?').bind(id),
        db.prepare('DELETE FROM characters WHERE character_id = ? AND account_id = ?').bind(id, acc.id),
      ]);
      return json({ ok: true });
    }
  }

  // "Check now" for this account's characters (the schedule does it every 10 minutes anyway).
  if (path === '/api/poll' && m === 'POST') {
    return json({ results: await pollDue(env, fetchImpl, { accountId: acc.id, minAgeMs: 2 * 60e3 }) });
  }

  return fail(404, 'Not found');
}

// ---------------------------------------------------------------- entry
export async function handle(req, env, fetchImpl = fetch) {
  const path = new URL(req.url).pathname;
  try {
    if (path.startsWith('/auth/') || path.startsWith('/api/')) await ensureSchema(env.DB);
    if (path === '/auth/login') return await authLogin(req, env);
    if (path === '/auth/callback') return await authCallback(req, env, fetchImpl);
    if (path === '/auth/logout') return await authLogout(req, env);
    if (path.startsWith('/api/')) return await api(req, env, path, fetchImpl);
  } catch (e) {
    console.error(e);
    return fail(e.status === 503 ? 503 : 500, e.status === 503 ? e.message : 'Server error');
  }
  return env.ASSETS.fetch(req);
}

export default {
  fetch: (req, env) => handle(req, env),
  scheduled: (event, env, ctx) => ctx.waitUntil(scheduled(event, env)),
};
