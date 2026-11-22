// Background work, run by the Cloudflare schedule:
//   every 10 minutes: read each character's ESI mining ledger and record any new ice
//   every hour:       refresh Jita prices for compressed ice
import { ICE, PRICED } from '../public/ice.js';
import { ensureSchema, getMeta, setMeta } from './db.js';
import { accessToken } from './tokens.js';

const ESI = 'https://esi.evetech.net/latest';
const UA = 'MiningLedger (miningledger.crankyape.space)';
export const PRICE_CRON = '5 * * * *';
// Free Workers allow 50 outside requests per run: about 3 per character (token refresh + ledger pages).
export const CHARS_PER_RUN = 12;
const TOTALS_KEEP_DAYS = 35; // ESI only returns the last 30 days

const dayStr = ms => new Date(ms).toISOString().slice(0, 10);

async function esi(path, fetchImpl, token) {
  const r = await fetchImpl(`${ESI}${path}`, { headers: { 'User-Agent': UA, Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
  if (!r.ok) throw Object.assign(new Error(`ESI ${r.status} on ${path.split('?')[0]}`), { status: r.status });
  return { data: await r.json(), pages: Number(r.headers.get('X-Pages') || 1) };
}

/** Reads one character's ledger and stores what changed since last time. Returns the number of new ice entries. */
export async function pollCharacter(env, row, fetchImpl = fetch, now = Date.now()) {
  const db = env.DB;
  try {
    const token = await accessToken(env, row, fetchImpl);
    const first = await esi(`/characters/${row.character_id}/mining/?datasource=tranquility&page=1`, fetchImpl, token);
    let entries = first.data;
    for (let p = 2; p <= Math.min(first.pages, 5); p++) entries = entries.concat((await esi(`/characters/${row.character_id}/mining/?datasource=tranquility&page=${p}`, fetchImpl, token)).data);
    const ice = entries.filter(e => ICE[e.type_id]);

    const { results } = await db.prepare('SELECT date, solar_system_id, type_id, quantity FROM ledger_totals WHERE character_id = ?').bind(row.character_id).all();
    const had = new Map(results.map(t => [`${t.date}|${t.solar_system_id}|${t.type_id}`, t.quantity]));
    const backfill = !row.last_poll; // first check: history from before tracking, time of day unknown
    const writes = [];
    for (const e of ice) {
      const key = `${e.date}|${e.solar_system_id}|${e.type_id}`;
      const delta = e.quantity - (had.get(key) ?? 0);
      if (delta <= 0) continue;
      writes.push(db.prepare(`INSERT INTO ledger_totals (character_id, date, solar_system_id, type_id, quantity) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(character_id, date, solar_system_id, type_id) DO UPDATE SET quantity = excluded.quantity`)
        .bind(row.character_id, e.date, e.solar_system_id, e.type_id, e.quantity));
      const approx = backfill ? 1 : 0;
      const at = backfill ? Math.min(now, Date.parse(`${e.date}T00:00:00Z`)) : now;
      writes.push(db.prepare('INSERT INTO mining_events (character_id, at, date, solar_system_id, type_id, quantity, approx) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(row.character_id, at, e.date, e.solar_system_id, e.type_id, delta, approx));
    }
    writes.push(db.prepare('UPDATE characters SET last_poll = ?, last_error = NULL WHERE character_id = ?').bind(now, row.character_id));
    writes.push(db.prepare('DELETE FROM ledger_totals WHERE character_id = ? AND date < ?').bind(row.character_id, dayStr(now - TOTALS_KEEP_DAYS * 86400e3)));
    await db.batch(writes);
    return { id: row.character_id, added: (writes.length - 2) / 2 };
  } catch (e) {
    const msg = e.status === 403 ? 'EVE refused access to the mining ledger: log this character in again' : e.message;
    await db.prepare('UPDATE characters SET last_poll = ?, last_error = ? WHERE character_id = ?').bind(now, msg, row.character_id).run();
    return { id: row.character_id, error: msg };
  }
}

/** Checks the characters that have waited longest (all accounts, or just one). */
export async function pollDue(env, fetchImpl = fetch, { accountId = null, minAgeMs = 9 * 60e3 } = {}) {
  const now = Date.now();
  const q = accountId == null
    ? env.DB.prepare('SELECT * FROM characters WHERE needs_login = 0 AND last_poll < ? ORDER BY last_poll LIMIT ?').bind(now - minAgeMs, CHARS_PER_RUN)
    : env.DB.prepare('SELECT * FROM characters WHERE needs_login = 0 AND account_id = ? AND last_poll < ? ORDER BY last_poll LIMIT ?').bind(accountId, now - minAgeMs, CHARS_PER_RUN);
  const { results } = await q.all();
  const out = [];
  for (const row of results) out.push(await pollCharacter(env, row, fetchImpl, now));
  await setMeta(env.DB, 'last_poll_run', JSON.stringify({ at: now, checked: out.length })).run();
  return out;
}

// ---------------------------------------------------------------- prices
const JITA_STATION = 60003760, JITA_SYSTEM = 30000142, THE_FORGE = 10000002;

/** Best Jita buy and sell for one type: Jita 4-4 first, then anywhere in Jita, then The Forge. */
export async function jitaPrice(typeId, fetchImpl = fetch) {
  const first = await esi(`/markets/${THE_FORGE}/orders/?datasource=tranquility&order_type=all&type_id=${typeId}&page=1`, fetchImpl);
  let orders = first.data;
  for (let p = 2; p <= Math.min(first.pages, 3); p++) orders = orders.concat((await esi(`/markets/${THE_FORGE}/orders/?datasource=tranquility&order_type=all&type_id=${typeId}&page=${p}`, fetchImpl)).data);
  const pick = isBuy => {
    const side = orders.filter(o => o.is_buy_order === isBuy);
    for (const [where, test] of [['Jita 4-4', o => o.location_id === JITA_STATION], ['Jita', o => o.system_id === JITA_SYSTEM], ['The Forge', () => true]]) {
      const set = side.filter(test);
      if (set.length) return { price: isBuy ? Math.max(...set.map(o => o.price)) : Math.min(...set.map(o => o.price)), where };
    }
    return { price: null, where: null };
  };
  const buy = pick(true), sell = pick(false);
  return { buy: buy.price, sell: sell.price, note: [buy.where && buy.where !== 'Jita 4-4' ? `buy from ${buy.where}` : '', sell.where && sell.where !== 'Jita 4-4' ? `sell from ${sell.where}` : ''].filter(Boolean).join(', ') || null };
}

export async function refreshPrices(env, fetchImpl = fetch) {
  const now = Date.now();
  const writes = [], errors = [];
  for (const id of Object.keys(PRICED).map(Number)) {
    try {
      const p = await jitaPrice(id, fetchImpl);
      writes.push(env.DB.prepare(`INSERT INTO prices (type_id, buy, sell, note, updated) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(type_id) DO UPDATE SET buy = excluded.buy, sell = excluded.sell, note = excluded.note, updated = excluded.updated`).bind(id, p.buy, p.sell, p.note, now));
    } catch (e) { errors.push(`${id}: ${e.message}`); }
  }
  writes.push(setMeta(env.DB, 'prices_updated', now));
  await env.DB.batch(writes);
  return { updated: writes.length - 1, errors };
}

export async function scheduled(event, env, fetchImpl = fetch) {
  await ensureSchema(env.DB);
  // Prices and a full character check together would go over the 50-request limit, so a run does one or the other.
  if (event?.cron === PRICE_CRON || !(await getMeta(env.DB, 'prices_updated'))) return refreshPrices(env, fetchImpl);
  return pollDue(env, fetchImpl);
}
