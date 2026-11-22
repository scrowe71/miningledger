// MiningLedger web app. All data comes from this site's own API, scoped to the logged-in account.
import { ICE, PRICED, PRODUCTS, MATERIALS, POLL_MINUTES } from './ice.js';

const APP_VERSION = '1.1.0';
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const RANGES = { 7: 'Last 7 days', 30: 'Last 30 days', 90: 'Last 90 days', 365: 'Last year', 0: 'All time' };

const state = {
  me: null, prices: {}, pricesUpdated: null, events: [], totals: [], systems: {},
  tab: 'sessions', range: 30, open: new Set(),
};

// ---------------------------------------------------------------- formatting
function isk(n) {
  if (n == null || !isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(2)}b`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(1)}m`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(0)}k`;
  return n.toFixed(0);
}
const num = n => n == null || !isFinite(n) ? '—' : Math.round(n).toLocaleString('en-US');
const pad = n => String(n).padStart(2, '0');
const evetime = ms => { const d = new Date(ms); return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };
const evedate = ms => new Date(ms).toISOString().slice(0, 10);
function dur(ms) {
  const m = Math.max(0, Math.round(ms / 60e3));
  return m >= 60 ? `${Math.floor(m / 60)}h ${pad(m % 60)}m` : `${m}m`;
}
function ago(ms) {
  if (!ms) return 'never';
  const m = Math.round((Date.now() - ms) / 60e3);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)} h ago`;
  return `${Math.round(m / 1440)} days ago`;
}
const portrait = (id, size = 32) => `<img class="pt" src="https://images.evetech.net/characters/${id}/portrait?size=${size * 2}" width="${size}" height="${size}" alt="">`;
const typeIcon = id => `<img class="ti" src="https://images.evetech.net/types/${id}/icon?size=32" width="20" height="20" alt="">`;
const charName = id => state.me?.characters.find(c => c.character_id === id)?.name ?? `#${id}`;
const sysName = id => state.systems[id] ?? `System ${id}`;

// ---------------------------------------------------------------- value
/** ISK for `units` of a raw ice type: valued as its compressed form (1:1), today's price, your percentage. */
function value(typeId, units) {
  const s = state.me.settings;
  const p = state.prices[ICE[typeId]?.value];
  if (!p) return null;
  const unit = s.price_source === 'Jita Sell' ? p.sell : p.buy;
  return unit == null ? null : units * unit * s.percentage / 100;
}
const cmp = () => state.me.settings.compare;
/** Refined value of one unit of ice at Jita buy and the buyback's refine yield (before the buyback's percentage). */
function refinedUnit(typeId) {
  const mats = MATERIALS[typeId];
  if (!mats) return null;
  let v = 0;
  for (const [id, n] of Object.entries(mats)) { const p = state.prices[id]?.buy; if (p == null) return null; v += n * p; }
  return v * cmp().yield / 100;
}
const accepted = typeId => cmp().accepted.includes(Number(typeId)) && !!MATERIALS[typeId];
/** What the comparison buyback would pay: 0 for ice it doesn't accept, null if prices are missing. */
function bbValue(typeId, units) {
  if (!accepted(typeId)) return 0;
  const u = refinedUnit(typeId);
  return u == null ? null : units * u * cmp().percentage / 100;
}
function sumValue(rows) {
  let v = 0, bb = 0, missing = false, rejected = 0;
  for (const r of rows) {
    const x = value(r.y, r.q); if (x == null) missing = true; else v += x;
    const b = bbValue(r.y, r.q); if (b != null) bb += b;
    if (!accepted(r.y)) rejected += r.q;
  }
  return { v, bb, missing, rejected };
}
const showBB = () => cmp().enabled;
/** "KFBP 52.1m (−12%)": the buyback figure and how it compares with your own value. */
function bbNote(sv, { short = true } = {}) {
  if (!showBB()) return '';
  const d = sv.v > 0 ? (sv.bb - sv.v) / sv.v * 100 : null;
  const diff = d == null ? '' : ` <span class="${d >= 0 ? 'up' : 'down'}">(${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(0)}%)</span>`;
  return `${short ? esc(cmp().short) + ' ' : ''}${isk(sv.bb)}${diff}`;
}

// ---------------------------------------------------------------- api
async function api(path, opts = {}) {
  const r = await fetch(path, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, ...opts });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(body.error || `Request failed (${r.status})`), { status: r.status });
  return body;
}
function status(text, working = false) { const el = $('#status'); el.textContent = text; el.classList.toggle('working', working); }
function toast(text, bad = false) {
  const t = document.createElement('div');
  t.className = `toast${bad ? ' bad' : ''}`; t.textContent = text;
  $('#toasts').append(t); setTimeout(() => t.remove(), 6000);
}

async function loadSystems(ids) {
  const want = [...new Set(ids)].filter(id => !state.systems[id]);
  if (!want.length) return;
  try {
    const cached = JSON.parse(localStorage.getItem('ml_systems') || '{}');
    Object.assign(state.systems, cached);
  } catch { /* storage unavailable */ }
  const still = want.filter(id => !state.systems[id]);
  for (let i = 0; i < still.length; i += 500) {
    try {
      const r = await fetch('https://esi.evetech.net/latest/universe/names/?datasource=tranquility', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(still.slice(i, i + 500)) });
      if (r.ok) for (const n of await r.json()) state.systems[n.id] = n.name;
    } catch { /* names are cosmetic */ }
  }
  try { localStorage.setItem('ml_systems', JSON.stringify(state.systems)); } catch { /* ignore */ }
}

async function loadData() {
  status('Loading…', true);
  const from = state.range ? Date.now() - state.range * 86400e3 : 1;
  const [ev, tot, pr] = await Promise.all([api(`/api/events?from=${from}`), api('/api/totals'), api('/api/prices')]);
  state.events = ev; state.totals = tot; state.prices = pr.prices; state.pricesUpdated = pr.updated;
  await loadSystems(ev.map(e => e.s));
  status('');
}

// ---------------------------------------------------------------- sessions
/** Groups timed entries from all characters into sessions split by gaps longer than the setting. */
function buildSessions(events) {
  const gap = state.me.settings.session_gap_minutes * 60e3;
  const timed = events.filter(e => !e.a).sort((a, b) => a.t - b.t);
  const out = [];
  let cur = null;
  for (const e of timed) {
    if (!cur || e.t - cur.last > gap) out.push(cur = { first: e.t, last: e.t, rows: [] });
    cur.last = e.t; cur.rows.push(e);
  }
  for (const s of out) {
    // An entry shows up at the first check after it was mined, so the session began up to one check earlier.
    s.start = s.first - POLL_MINUTES * 60e3;
    s.end = s.last;
    s.ms = s.end - s.start;
    s.active = Date.now() - s.last < gap;
    s.units = s.rows.reduce((n, r) => n + r.q, 0);
    Object.assign(s, sumValue(s.rows));
    s.chars = [...new Set(s.rows.map(r => r.c))];
    s.systems = [...new Set(s.rows.map(r => r.s))];
  }
  return out.reverse();
}

function breakdown(rows) {
  // character × ice type
  const m = new Map();
  for (const r of rows) {
    const k = `${r.c}|${r.y}`;
    m.set(k, (m.get(k) || 0) + r.q);
  }
  const lines = [...m].map(([k, q]) => { const [c, y] = k.split('|').map(Number); return { c, y, q, v: value(y, q), b: bbValue(y, q) }; })
    .sort((a, b) => charName(a.c).localeCompare(charName(b.c)) || (b.v ?? 0) - (a.v ?? 0));
  const bb = showBB();
  return `<table class="grid"><thead><tr><th>Character</th><th>Ice</th><th class="r">Units</th><th class="r">ISK</th>${bb ? `<th class="r">${esc(cmp().short)}</th>` : ''}</tr></thead><tbody>${
    lines.map(l => `<tr><td>${portrait(l.c, 20)} ${esc(charName(l.c))}</td><td>${typeIcon(l.y)} ${esc(ICE[l.y].name)}</td><td class="r">${num(l.q)}</td><td class="r">${isk(l.v)}</td>${
      bb ? `<td class="r">${accepted(l.y) ? isk(l.b) : '<span class="na">not accepted</span>'}</td>` : ''}</tr>`).join('')
  }</tbody></table>`;
}

// ---------------------------------------------------------------- views
function tiles() {
  const now = Date.now(), today = evedate(now);
  const all = sumValue(state.totals);
  const inRange = days => sumValue(state.events.filter(e => e.d >= evedate(now - (days - 1) * 86400e3)));
  const t = sumValue(state.events.filter(e => e.d === today));
  const sess = buildSessions(state.events)[0];
  const rate = sess && sess.ms > 0 ? sess.v / (sess.ms / 3600e3) : null;
  const tile = (label, sv, sub = '') => `<div class="tile"><span>${label}</span><b>${isk(sv.v)}</b>${sub ? `<i>${sub}</i>` : ''}${showBB() ? `<i class="bb">${bbNote(sv)}</i>` : ''}</div>`;
  const none = { v: 0, bb: 0 };
  return `<div class="tiles">
    ${tile('Today (EVE time)', t)}
    ${state.range === 0 || state.range >= 7 ? tile('Last 7 days', inRange(7)) : ''}
    ${state.range === 0 || state.range >= 30 ? tile('Last 30 days', inRange(30)) : ''}
    ${tile('All time', all, `${num(state.totals.reduce((n, r) => n + r.q, 0))} units`)}
    ${tile(sess?.active ? 'This session' : 'Last session', sess ?? none, sess ? `${isk(rate)} ISK/hr · ${dur(sess.ms)}${sess.active ? ' · <em>active</em>' : ''}` : 'none yet')}
  </div>`;
}

function priceLine() {
  const s = state.me.settings;
  const when = state.pricesUpdated ? ago(state.pricesUpdated) : 'not yet loaded';
  const c = s.compare;
  const bb = c.enabled ? ` Compared with <b>${esc(c.name)}</b> (${esc(c.short)}): ${c.percentage}% of refined value at Jita buy, ${c.yield}% refine yield; ice it doesn't accept counts as 0.` : '';
  return `<p class="hint">Valued as compressed ice at <b>${esc(s.price_source)}</b> × <b>${s.percentage}%</b>, using today's price for every day (prices updated ${when}).${bb} <a href="#" data-go="settings">Change</a></p>`;
}

function rangePicker() {
  return `<label class="field">Show <select id="range">${Object.entries(RANGES).sort((a, b) => (+a[0] || 1e9) - (+b[0] || 1e9))
    .map(([k, v]) => `<option value="${k}"${+k === state.range ? ' selected' : ''}>${v}</option>`).join('')}</select></label>`;
}

function viewSessions() {
  const sessions = buildSessions(state.events);
  const approx = state.events.filter(e => e.a);
  const toolbar = `<div class="toolbar">${rangePicker()}<span class="grow"></span>
    <button id="pollNow">Check ESI now</button><button id="csv">Export CSV</button></div>`;
  if (!sessions.length && !approx.length) {
    return `${tiles()}${toolbar}<div class="empty"><h3>No ice yet</h3><p>MiningLedger checks each character's mining ledger every ${POLL_MINUTES} minutes. Ice shows up here once EVE publishes it, usually 10 to 20 minutes after it's mined.</p></div>${priceLine()}`;
  }
  const rows = sessions.map((s, i) => {
    const key = String(s.first), open = state.open.has(key);
    const rate = s.ms > 0 ? s.v / (s.ms / 3600e3) : null;
    return `<div class="sess${s.active ? ' active' : ''}${open ? ' open' : ''}" data-key="${key}">
      <button class="sess-head" aria-expanded="${open}">
        <span class="when"><b>${evedate(s.start)}</b> ${evetime(s.start)}–${s.active ? 'now' : evetime(s.end)} <i>${dur(s.ms)}</i></span>
        <span class="who">${s.chars.slice(0, 8).map(c => portrait(c, 22)).join('')}${s.chars.length > 8 ? `<i>+${s.chars.length - 8}</i>` : ''}</span>
        <span class="where">${esc(s.systems.map(sysName).join(', '))}</span>
        <span class="r units">${num(s.units)} u</span>
        <span class="r rate">${isk(rate)}/hr</span>
        <span class="r total">${isk(s.v)}${s.missing ? '*' : ''}</span>
        ${showBB() ? `<span class="r bbcol">${bbNote(s, { short: false })}</span>` : ''}
      </button>
      ${open ? `<div class="sess-body">${breakdown(s.rows)}</div>` : ''}
    </div>`;
  }).join('');
  const approxDays = [...new Set(approx.map(e => e.d))].sort().reverse();
  const earlier = approx.length ? `<h3 class="sub">Before tracking started</h3>
    <p class="hint">Mining from the 30 days of history EVE had when each character was added. EVE only gives daily totals for these, so there's no session time or ISK/hr.</p>
    ${approxDays.map(d => { const r = approx.filter(e => e.d === d); const sv = sumValue(r); const key = `a${d}`, open = state.open.has(key);
      return `<div class="${showBB() ? 'with-bb ' : ''}sess${open ? ' open' : ''}" data-key="${key}"><button class="sess-head approx" aria-expanded="${open}"><span class="when"><b>${d}</b> <i>whole day</i></span>
        <span class="who">${[...new Set(r.map(e => e.c))].map(c => portrait(c, 22)).join('')}</span><span class="where">${esc([...new Set(r.map(e => e.s))].map(sysName).join(', '))}</span>
        <span class="r units">${num(r.reduce((n, e) => n + e.q, 0))} u</span><span class="r rate"></span><span class="r total">${isk(sv.v)}</span>${showBB() ? `<span class="r bbcol">${bbNote(sv, { short: false })}</span>` : ''}</button>
        ${open ? `<div class="sess-body">${breakdown(r)}</div>` : ''}</div>`; }).join('')}` : '';
  const head = showBB() ? `<div class="sess-cols"><span>Session</span><span></span><span>Systems</span><span class="r">Units</span><span class="r">ISK/hr</span><span class="r">Your value</span><span class="r">${esc(cmp().short)}</span></div>` : '';
  return `${tiles()}${toolbar}${head}<div class="sessions${showBB() ? ' with-bb' : ''}">${rows || '<p class="hint">No timed sessions in this range yet.</p>'}</div>${earlier}${priceLine()}`;
}

function viewDays() {
  const byDay = new Map();
  for (const e of state.events) { if (!byDay.has(e.d)) byDay.set(e.d, []); byDay.get(e.d).push(e); }
  const days = [...byDay].sort((a, b) => b[0].localeCompare(a[0])).map(([d, r]) => ({ d, r, ...sumValue(r), units: r.reduce((n, e) => n + e.q, 0) }));
  const max = Math.max(1, ...days.map(d => d.v));
  let running = days.reduce((n, d) => n + d.v, 0);
  const body = days.map(d => { const line = `<tr><td><b>${d.d}</b></td><td class="bar"><i style="width:${(d.v / max * 100).toFixed(1)}%"></i></td>
    <td class="r">${num(d.units)}</td><td class="r">${isk(d.v)}</td>${showBB() ? `<td class="r">${bbNote(d, { short: false })}</td>` : ''}<td class="r dim">${isk(running)}</td></tr>`; running -= d.v; return line; }).join('');
  return `${tiles()}<div class="toolbar">${rangePicker()}<span class="grow"></span><button id="csv">Export CSV</button></div>
    ${days.length ? `<table class="grid days"><thead><tr><th>Day (EVE)</th><th></th><th class="r">Units</th><th class="r">ISK</th>${showBB() ? `<th class="r">${esc(cmp().short)}</th>` : ''}<th class="r">Cumulative</th></tr></thead><tbody>${body}</tbody></table>` : '<div class="empty"><p>No ice in this range.</p></div>'}
    ${priceLine()}`;
}

function viewCharacters() {
  const me = state.me;
  const totalsBy = c => sumValue(state.totals.filter(t => t.c === c));
  const rows = me.characters.map(c => {
    const t = totalsBy(c.character_id);
    const problem = c.needs_login || c.last_error;
    return `<tr><td>${portrait(c.character_id, 32)}</td>
      <td><b>${esc(c.name)}</b>${c.is_main ? ' <span class="tag">main</span>' : ''}${problem ? `<div class="err">${esc(c.last_error || 'Needs to log in again')} <a href="/auth/login?add=1">Log in again</a></div>` : ''}</td>
      <td class="dim">${c.last_poll ? `checked ${ago(c.last_poll)}` : 'first check pending'}</td>
      <td class="r">${isk(t.v)}${showBB() ? `<div class="bb">${bbNote(t)}</div>` : ''}</td>
      <td class="r">${c.is_main ? '' : `<button class="link" data-main="${c.character_id}">Make main</button> <button class="link bad" data-remove="${c.character_id}">Remove</button>`}</td></tr>`;
  }).join('');
  return `<div class="toolbar"><a class="btn primary" href="/auth/login?add=1">+ Add a character</a><span class="grow"></span><button id="pollNow">Check ESI now</button></div>
    <table class="grid chars"><thead><tr><th></th><th>Character</th><th>Ledger</th><th class="r">All-time ISK</th><th></th></tr></thead><tbody>${rows}</tbody></table>
    <p class="hint">Characters belong to one MiningLedger account only. A character already linked to someone else's account can't be added to yours, and logging in with any of your alts opens this account.
    To add an alt, use <b>Add a character</b> and pick it on the EVE login page (log out of EVE there first if it signs you straight back in as the same character).
    Removing a character deletes its mining entries from MiningLedger.</p>`;
}

function viewSettings() {
  const s = state.me.settings, c = s.compare;
  const rawOf = Object.fromEntries(Object.entries(ICE).map(([raw, t]) => [t.value, raw]));
  const priceRows = Object.entries(PRICED).map(([id, name]) => { const p = state.prices[id] || {}; const raw = rawOf[id];
    const bb = c.enabled ? (accepted(raw) ? num(bbValue(raw, 1) ?? NaN) : '<span class="na">not accepted</span>') : '';
    return `<tr><td>${typeIcon(id)} ${esc(name)}</td><td class="r">${p.buy != null ? num(p.buy) : '—'}</td><td class="r">${p.sell != null ? num(p.sell) : '—'}</td><td class="r">${num(value(raw, 1) ?? NaN)}</td>${c.enabled ? `<td class="r">${bb}</td>` : ''}<td class="dim">${esc(p.note || '')}</td></tr>`; }).join('');
  const productRows = Object.entries(PRODUCTS).map(([id, name]) => { const p = state.prices[id] || {};
    return `<tr><td>${typeIcon(id)} ${esc(name)}</td><td class="r">${p.buy != null ? p.buy.toLocaleString('en-US') : '—'}</td><td class="r">${p.sell != null ? p.sell.toLocaleString('en-US') : '—'}</td><td class="dim">${esc(p.note || '')}</td></tr>`; }).join('');
  return `<form id="settings" class="panel form">
      <h3>Ice value</h3>
      <label class="field">Price source <select name="price_source">${state.me.price_sources.map(p => `<option${p === s.price_source ? ' selected' : ''}>${esc(p)}</option>`).join('')}</select></label>
      <label class="field">Percentage of price <input name="percentage" type="number" min="1" max="200" step="0.1" value="${s.percentage}"> %</label>
      <p class="hint">Every unit of raw ice is valued as one unit of its compressed type (compression is 1:1). Azure Ice and Crystalline Icicle can't be compressed, so they use their own price. All days use today's price.</p>
      <h3>Sessions</h3>
      <label class="field">New session after a gap of <input name="session_gap_minutes" type="number" min="15" max="240" step="5" value="${s.session_gap_minutes}"> minutes</label>
      <p class="hint">EVE updates mining ledgers in batches, so entries arrive roughly every ${POLL_MINUTES} to 20 minutes while you mine. A gap shorter than 20 minutes will split one session into several.</p>
      <h3>Compare with a buyback</h3>
      <label class="field"><input type="checkbox" name="bb_enabled"${c.enabled ? ' checked' : ''}> Show what a refining buyback would pay next to your own value</label>
      <label class="field">Name <input name="bb_name" value="${esc(c.name)}" maxlength="40" style="width:220px"> Short name <input name="bb_short" value="${esc(c.short)}" maxlength="8" style="width:80px"></label>
      <label class="field">Pays <input name="bb_pct" type="number" min="1" max="200" step="0.1" value="${c.percentage}"> % of refined value at Jita buy, refine yield <input name="bb_yield" type="number" min="50" max="100" step="0.1" value="${c.yield}"> %</label>
      <div class="field">Accepts:</div>
      <div class="accept">${Object.entries(ICE).map(([id, t]) => `<label><input type="checkbox" name="bb_acc" value="${id}"${c.accepted.includes(+id) ? ' checked' : ''}${MATERIALS[id] ? '' : ' disabled'}> ${esc(t.name)}</label>`).join('')}</div>
      <p class="hint">Set up from a KarmaFleet quote on 2026-11-22: 70% of the refined value at Jita buy. In that quote, Dark Glitter, Glare Crust and Gelidus were not accepted. Krystallos wasn't in the quote, so it's switched off here as a guess. A ${c.yield}% refine yield matched their per-unit price to within about 0.5%. Azure Ice and Crystalline Icicle have no refine data here, so they always count as not accepted.</p>
      <button class="primary" type="submit">Save</button>
    </form>
    <div class="panel"><h3>Jita prices (ISK per unit)</h3><table class="grid"><thead><tr><th>Type</th><th class="r">Buy</th><th class="r">Sell</th><th class="r">You (${esc(s.price_source)} × ${s.percentage}%)</th>${c.enabled ? `<th class="r">${esc(c.short)}</th>` : ''}<th></th></tr></thead><tbody>${priceRows}</tbody></table>
    <h3>Ice products</h3><table class="grid"><thead><tr><th>Type</th><th class="r">Buy</th><th class="r">Sell</th><th></th></tr></thead><tbody>${productRows}</tbody></table>
    <p class="hint">Highest buy and lowest sell order at Jita IV - Moon 4 - Caldari Navy Assembly Plant, refreshed hourly${state.pricesUpdated ? `, last ${ago(state.pricesUpdated)}` : ''}.</p></div>`;
}

function render() {
  if (!state.me?.logged_in) return;
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === state.tab));
  $('#view').innerHTML = { sessions: viewSessions, days: viewDays, characters: viewCharacters, settings: viewSettings }[state.tab]();
}

function renderWho() {
  const me = state.me;
  if (!me?.logged_in) { $('#who').innerHTML = ''; return; }
  const main = me.characters.find(c => c.is_main) || me.characters[0];
  $('#who').innerHTML = `${portrait(main.character_id, 28)} <span>${esc(main.name)}${me.characters.length > 1 ? ` <i class="dim">+${me.characters.length - 1}</i>` : ''}</span> <a class="link" href="/auth/logout">Log out</a>`;
}

function showLoggedOut() {
  $('#tabs').hidden = true;
  $('#view').innerHTML = `<section class="hero">
    <h1>Ice mining, totalled.</h1>
    <p>Log in with your main, add your alts, and MiningLedger reads every character's EVE mining ledger to show what your ice is worth, session by session, valued as compressed ice at today's Jita price.</p>
    <a class="btn primary big" href="/auth/login"><img src="https://web.ccpgamescdn.com/eveonlineassets/developers/eve-sso-login-white-large.png" alt="Log in with EVE Online" height="40"></a>
    <p class="hint">The only permission asked for is reading the mining ledger. Your characters are visible only to you.</p>
  </section>`;
}

function exportCsv() {
  const s = state.me.settings;
  const bbOn = showBB(), short = cmp().short.replace(/[^\w]/g, '').toLowerCase() || 'buyback';
  const head = ['eve_time', 'date', 'character', 'system', 'ice', 'units', 'valued_as', 'unit_price', 'isk', ...(bbOn ? [`${short}_isk`] : []), 'time_known'];
  const lines = [...state.events].sort((a, b) => a.t - b.t).map(e => {
    const v = value(e.y, e.q), p = state.prices[ICE[e.y].value];
    const unit = p ? (s.price_source === 'Jita Sell' ? p.sell : p.buy) : '';
    return [e.a ? '' : new Date(e.t).toISOString().slice(0, 16).replace('T', ' '), e.d, charName(e.c), sysName(e.s), ICE[e.y].name, e.q, PRICED[ICE[e.y].value], unit ?? '', v == null ? '' : v.toFixed(2), ...(bbOn ? [accepted(e.y) ? (bbValue(e.y, e.q) ?? 0).toFixed(2) : 'not accepted'] : []), e.a ? 'day only' : 'yes'];
  });
  const csv = [head, ...lines].map(r => r.map(x => /[",\n]/.test(String(x)) ? `"${String(x).replace(/"/g, '""')}"` : x).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `miningledger-${evedate(Date.now())}.csv`;
  a.click(); URL.revokeObjectURL(a.href);
}

async function pollNow(quiet = false) {
  status('Checking ESI…', true);
  try {
    const { results } = await api('/api/poll', { method: 'POST' });
    const errs = results.filter(r => r.error), added = results.reduce((n, r) => n + (r.added || 0), 0);
    if (!quiet) toast(results.length ? `Checked ${results.length} character${results.length === 1 ? '' : 's'}: ${added ? `${added} new entr${added === 1 ? 'y' : 'ies'}` : 'nothing new'}${errs.length ? `, ${errs.length} problem${errs.length === 1 ? '' : 's'}` : ''}` : 'Everything was checked in the last 2 minutes');
    state.me = await api('/api/me');
    await loadData();
    renderWho(); render();
  } catch (e) { status(''); toast(e.message, true); }
}

// ---------------------------------------------------------------- events
document.addEventListener('click', async e => {
  const t = e.target.closest('button, a');
  if (!t) return;
  if (t.matches('#tabs button')) { state.tab = t.dataset.tab; render(); return; }
  if (t.dataset.go) { e.preventDefault(); state.tab = t.dataset.go; render(); return; }
  if (t.classList.contains('sess-head')) { const k = t.parentElement.dataset.key; state.open.has(k) ? state.open.delete(k) : state.open.add(k); render(); return; }
  if (t.id === 'csv') { exportCsv(); return; }
  if (t.id === 'pollNow') { t.disabled = true; await pollNow(); return; }
  if (t.dataset.main) {
    await api(`/api/characters/${t.dataset.main}/main`, { method: 'POST' }).catch(err => toast(err.message, true));
    state.me = await api('/api/me'); renderWho(); render(); return;
  }
  if (t.dataset.remove) {
    const name = charName(+t.dataset.remove);
    if (!confirm(`Remove ${name}? Its mining entries are deleted from MiningLedger.`)) return;
    try { await api(`/api/characters/${t.dataset.remove}`, { method: 'DELETE' }); toast(`${name} removed`); } catch (err) { toast(err.message, true); }
    state.me = await api('/api/me'); await loadData(); renderWho(); render();
  }
});
document.addEventListener('change', async e => {
  if (e.target.id === 'range') { state.range = Number(e.target.value); await loadData().catch(err => toast(err.message, true)); render(); }
});
document.addEventListener('submit', async e => {
  if (e.target.id !== 'settings') return;
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    const { settings } = await api('/api/settings', { method: 'PUT', body: JSON.stringify({
      price_source: f.get('price_source'), percentage: Number(f.get('percentage')), session_gap_minutes: Number(f.get('session_gap_minutes')),
      compare: { enabled: f.get('bb_enabled') === 'on', name: f.get('bb_name'), short: f.get('bb_short'), percentage: Number(f.get('bb_pct')), yield: Number(f.get('bb_yield')), accepted: f.getAll('bb_acc').map(Number) },
    }) });
    state.me.settings = settings; toast('Settings saved'); render();
  } catch (err) { toast(err.message, true); }
});

// ---------------------------------------------------------------- start
function tick() { $('#evetime').textContent = evetime(Date.now()); }

async function start() {
  $('#version').textContent = `v${APP_VERSION}`;
  tick(); setInterval(tick, 15e3);
  const params = new URLSearchParams(location.search);
  if (params.get('msg')) {
    $('#banner').innerHTML = `<div class="banner">${esc(params.get('msg'))}</div>`;
    history.replaceState(null, '', '/');
  }
  try { state.me = await api('/api/me'); } catch (e) { status(''); toast(e.message, true); return; }
  renderWho();
  if (!state.me.logged_in) { showLoggedOut(); return; }
  $('#tabs').hidden = false;
  await loadData().catch(e => { status(''); toast(e.message, true); });
  render();
  // A newly added character gets its 30-day history straight away instead of at the next scheduled check.
  if (state.me.characters.some(c => !c.last_poll && !c.needs_login)) pollNow(true);
  // Refresh while the page is open (entries arrive every ~10 minutes).
  setInterval(async () => {
    if (document.hidden) return;
    try { state.me = await api('/api/me'); await loadData(); renderWho(); render(); } catch { /* try again next time */ }
  }, 5 * 60e3);
}
start();
