// MiningLedger web app. All data comes from this site's own API, scoped to the logged-in account.
import { ICE, PRICED, PRODUCTS, MATERIALS, POLL_MINUTES, BUYBACK_DEFAULTS, BUYBACK_BASES } from './ice.js';

const APP_VERSION = '1.4.3';
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const RANGES = { 7: 'Last 7 days', 30: 'Last 30 days', 90: 'Last 90 days', 365: 'Last year', 0: 'All time' };

const state = {
  me: null, prices: {}, pricesUpdated: null, events: [], totals: [], systems: {}, times: [], allEvents: null, hq: '',
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
// The EVE image server only serves 32, 64, 128, 256, 512 or 1024 px; ask for the next size up from 2× (sharp on hi-dpi screens).
const imgSize = px => [32, 64, 128, 256, 512, 1024].find(n => n >= px * 2) || 1024;
const portrait = (id, size = 32) => `<img class="pt" src="https://images.evetech.net/characters/${id}/portrait?size=${imgSize(size)}" width="${size}" height="${size}" alt="" loading="lazy">`;
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
// ---------------------------------------------------------------- buybacks
const bbs = () => state.me.settings.buybacks.filter(b => b.enabled);
const showBB = () => bbs().length > 0;
/** Refined value of one unit of ice: ice products at the buyback's Jita price × its refine yield (before its percentage). */
function refinedUnit(b, typeId) {
  const mats = MATERIALS[typeId];
  if (!mats) return null;
  let v = 0;
  for (const [id, n] of Object.entries(mats)) {
    const p = state.prices[id]; const x = b.basis === 'Jita Sell' ? p?.sell : p?.buy;
    if (x == null) return null; v += n * x;
  }
  return v * b.yield / 100;
}
const accepted = (b, typeId) => b.accepted.includes(Number(typeId)) && !!MATERIALS[typeId];
/** What a buyback pays for `units` of a raw ice type: 0 if it doesn't take it, null if prices are missing. */
function bbValue(b, typeId, units) {
  if (!accepted(b, typeId)) return 0;
  const u = refinedUnit(b, typeId);
  return u == null ? null : units * u * b.percentage / 100;
}
/** Your value, each buyback's value, and "best": every entry sold to whichever buyback pays most for it. */
function sumValue(rows) {
  const list = bbs();
  let v = 0, best = 0, missing = false;
  const bb = list.map(() => 0);
  for (const r of rows) {
    const x = value(r.y, r.q); if (x == null) missing = true; else v += x;
    let top = 0;
    list.forEach((b, i) => { const y = bbValue(b, r.y, r.q) ?? 0; bb[i] += y; if (y > top) top = y; });
    best += top;
  }
  return { v, bb, best, missing };
}
const diffPct = (x, v) => {
  if (!(v > 0)) return '';
  const d = (x - v) / v * 100;
  return ` <span class="${d >= 0 ? 'up' : 'down'}">(${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(0)}%)</span>`;
};
/** Buyback i's figure, compared with your own value; the highest-paying buyback is marked. */
function bbNote(sv, i, { short = true } = {}) {
  const list = bbs(), x = sv.bb?.[i] ?? 0;
  const top = list.length > 1 && x > 0 && x >= Math.max(...sv.bb);
  return `<span class="${top ? 'top' : ''}">${short ? esc(list[i].short) + ' ' : ''}${isk(x)}${diffPct(x, sv.v)}</span>`;
}
/** Lines for a tile: one per buyback, plus the best split when there's more than one. */
const perHr = (x, ms) => ms > 0 ? x / (ms / 3600e3) : null;
const hrTag = (x, ms) => ms > 0 ? ` · ${isk(perHr(x, ms))}/hr` : '';
const showBest = sv => bbs().length > 1 && sv.best > Math.max(...sv.bb) + 1;
/** Lines for a tile: one per buyback, plus the best split when there's more than one. Pass ms to add ISK/hr. */
function bbLines(sv, ms = 0) {
  const list = bbs(), r = sv.r || sv;
  if (!list.length) return '';
  const lines = list.map((b, i) => `<i class="bb">${bbNote(sv, i)}${hrTag(r.bb[i], ms)}</i>`);
  if (showBest(sv)) lines.push(`<i class="bb best" title="Each ice type sold to whichever buyback pays most for it">Best split ${isk(sv.best)}${diffPct(sv.best, sv.v)}${hrTag(r.best, ms)}</i>`);
  return lines.join('');
}
/**
 * ISK/hr for one session under every valuation (yours, each buyback, best split), in total and per character,
 * so it can be set against other income such as ratting ISK/hr.
 */
function rateStrip(s) {
  if (!(s.ms > 0)) return '';
  const n = s.chars.length;
  const r = s.r || s;
  const items = [['Your value', r.v, ''], ...bbs().map((b, i) => [b.short, r.bb[i], b.name]), ...(showBest(r) ? [['Best split', r.best, 'Each ice type sold to whichever buyback pays most for it']] : [])];
  return `<div class="rates"><div class="rates-head">ISK/hr over ${dur(s.ms)} with ${n} character${n === 1 ? '' : 's'}${s.pre ? ` <em>· not counting ${num(s.pre)} units mined earlier today before tracking started (they're in the totals, but EVE gives no time for them)</em>` : ''}</div>${items.map(([label, x, title]) =>
    `<div class="rc${label === 'Best split' ? ' best' : ''}" title="${esc(title)}"><span>${esc(label)}</span><b>${isk(perHr(x, s.ms))}<small>/hr</small></b>${n > 1 ? `<i>${isk(perHr(x, s.ms) / n)}/hr per character</i>` : ''}</div>`).join('')}</div>`;
}
const bbHeads = (tag = 'th') => bbs().map(b => `<${tag} class="r" title="${esc(b.name)}">${esc(b.short)}</${tag}>`).join('');
const bbTds = (sv, ms = 0) => bbs().map((b, i) => `<td class="r bbv">${bbNote(sv, i, { short: false })}${ms > 0 ? `<small>${isk(perHr((sv.r || sv).bb[i], ms))}/hr</small>` : ''}</td>`).join('');
/** Shared session columns, plus one per buyback. */
const colsStyle = () => {
  const n = bbs().length;
  return n ? `style="grid-template-columns:134px 92px 56px 72px minmax(60px, 1fr) 52px 60px 86px${' 124px'.repeat(n)};column-gap:12px"`
    : 'style="grid-template-columns:128px 96px 64px 104px minmax(80px, 1fr) 64px 80px 80px"';
};

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
  const [ev, tot, pr, times] = await Promise.all([api(`/api/events?from=${from}`), api('/api/totals'), api('/api/prices'), api('/api/session-times')]);
  state.events = ev; state.totals = tot; state.prices = pr.prices; state.pricesUpdated = pr.updated; state.times = times;
  state.allEvents = null; // History reloads everything next time it's shown
  state.check = null;
  if (state.tab === 'history') await loadHistory();
  await loadSystems(ev.map(e => e.s));
  status('');
}

async function loadHistory() {
  if (state.allEvents) return;
  status('Loading history…', true);
  state.allEvents = state.range === 0 ? state.events : await api('/api/events?from=1');
  await loadSystems(state.allEvents.map(e => e.s));
  status('');
}

// ---------------------------------------------------------------- sessions
const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const idDate = ms => { const d = new Date(ms); return `${pad(d.getUTCDate())}${MON[d.getUTCMonth()]}${d.getUTCFullYear()}`; };
/**
 * Session IDs like 22NOV2026-S01: the EVE (UTC) date the session started, then its number that day.
 * Worked out from every detection time on the account, so an ID doesn't depend on the date range being viewed.
 */
let idCache = { key: '', list: [] };
function sessionIds() {
  const gap = state.me.settings.session_gap_minutes * 60e3;
  const key = `${gap}|${state.times.length}|${state.times[state.times.length - 1]}`;
  if (idCache.key === key) return idCache.list;
  const list = [];
  for (const t of state.times) {
    const cur = list[list.length - 1];
    if (!cur || t - cur.last > gap) list.push({ first: t, last: t }); else cur.last = t;
  }
  const perDay = {};
  for (const s of list) { const d = idDate(s.first - POLL_MINUTES * 60e3); perDay[d] = (perDay[d] || 0) + 1; s.id = `${d}-S${pad(perDay[d])}`; }
  idCache = { key, list };
  return list;
}
function idFor(first) {
  const list = sessionIds();
  let lo = 0, hi = list.length - 1;
  while (lo <= hi) { // the session whose detections span this time
    const mid = (lo + hi) >> 1;
    if (first < list[mid].first) hi = mid - 1; else if (first > list[mid].last) lo = mid + 1; else return list[mid].id;
  }
  return `${idDate(first - POLL_MINUTES * 60e3)}-S??`; // brand new, not in the list yet
}
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
    s.id = idFor(s.first);
    s.pre = 0;
  }
  // A character added mid-session has that day's earlier mining in its 30-day history, which EVE gives as a
  // day total with no time. Put it in the session the character was mining in that day, so the session holds
  // everything mined, but keep it out of ISK/hr: there's no telling how long it took.
  for (const e of events) e._in = false;
  for (const e of events.filter(x => x.a)) {
    const s = out.find(ss => ss.rows.some(r => r.c === e.c && r.d === e.d));
    if (s) { s.rows.push(e); s.pre += e.q; e._in = true; }
  }
  for (const s of out) {
    s.units = s.rows.reduce((n, r) => n + r.q, 0);
    Object.assign(s, sumValue(s.rows));
    s.r = s.pre ? sumValue(s.rows.filter(r => !r.a)) : sumValue(s.rows); // what ISK/hr is worked out from
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
  const lines = [...m].map(([k, q]) => { const [c, y] = k.split('|').map(Number); return { c, y, q, ...sumValue([{ y, q }]) }; })
    .sort((a, b) => charName(a.c).localeCompare(charName(b.c)) || (b.v ?? 0) - (a.v ?? 0));
  return `<table class="grid"><thead><tr><th>Character</th><th>Ice</th><th class="r">Units</th><th class="r">ISK</th>${bbHeads()}</tr></thead><tbody>${
    lines.map(l => `<tr><td>${portrait(l.c, 20)} ${esc(charName(l.c))}</td><td>${typeIcon(l.y)} ${esc(ICE[l.y].name)}</td><td class="r">${num(l.q)}</td><td class="r">${isk(l.v)}</td>${
      bbs().map((b, i) => `<td class="r bbv">${accepted(b, l.y) ? bbNote(l, i, { short: false }) : '<span class="na">not accepted</span>'}</td>`).join('')}</tr>`).join('')
  }</tbody></table>`;
}

// ---------------------------------------------------------------- views
function tiles() {
  const now = Date.now(), today = evedate(now);
  const all = sumValue(state.totals);
  const inRange = days => sumValue(state.events.filter(e => e.d >= evedate(now - (days - 1) * 86400e3)));
  const t = sumValue(state.events.filter(e => e.d === today));
  const sess = buildSessions(state.events)[0];
  const rate = sess && sess.ms > 0 ? perHr(sess.r.v, sess.ms) : null;
  const tile = (label, sv, sub = '', ms = 0) => `<div class="tile"><span>${label}</span><b>${isk(sv.v)}</b>${sub ? `<i>${sub}</i>` : ''}${bbLines(sv, ms)}</div>`;
  const none = { v: 0, bb: bbs().map(() => 0), best: 0 };
  return `<div class="tiles">
    ${tile('Today (EVE time)', t)}
    ${state.range === 0 || state.range >= 7 ? tile('Last 7 days', inRange(7)) : ''}
    ${state.range === 0 || state.range >= 30 ? tile('Last 30 days', inRange(30)) : ''}
    ${tile('All time', all, `${num(state.totals.reduce((n, r) => n + r.q, 0))} units`)}
    ${tile(sess?.active ? 'This session' : 'Last session', sess ?? none, sess ? `${isk(rate)} ISK/hr · ${dur(sess.ms)}${sess.active ? ' · <em>active</em>' : ''}` : 'none yet', sess?.ms)}
  </div>`;
}

function priceLine() {
  const s = state.me.settings;
  const when = state.pricesUpdated ? ago(state.pricesUpdated) : 'not yet loaded';
  const bb = showBB() ? ` Buybacks: ${bbs().map(b => `<b title="${esc(b.name)}">${esc(b.short)}</b> ${b.percentage}% of refined value at ${esc(b.basis)} (${b.yield}% yield)`).join(', ')}; ice a buyback doesn't take counts as 0 for it.` : '';
  return `<p class="hint">Valued as compressed ice at <b>${esc(s.price_source)}</b> × <b>${s.percentage}%</b>, using today's price for every day (prices updated ${when}).${bb} <a href="#" data-go="settings">Change</a></p>`;
}

function rangePicker() {
  return `<label class="field">Show <select id="range">${Object.entries(RANGES).sort((a, b) => (+a[0] || 1e9) - (+b[0] || 1e9))
    .map(([k, v]) => `<option value="${k}"${+k === state.range ? ' selected' : ''}>${v}</option>`).join('')}</select></label>`;
}

function viewSessions() {
  const sessions = buildSessions(state.events);
  const approx = state.events.filter(e => e.a && !e._in); // buildSessions has just marked the ones it took
  const toolbar = `<div class="toolbar">${rangePicker()}<span class="grow"></span>
    <button id="pollNow">Check ESI now</button><button id="csv">Export CSV</button></div>`;
  if (!sessions.length && !approx.length) {
    return `${tiles()}${toolbar}<div class="empty"><h3>No ice yet</h3><p>MiningLedger checks each character's mining ledger every ${POLL_MINUTES} minutes. Ice shows up here once EVE publishes it, usually 10 to 20 minutes after it's mined.</p></div>${priceLine()}`;
  }
  const bb = showBB(), cs = colsStyle();
  const who = ids => `${ids.slice(0, 6).map(c => portrait(c, 22)).join('')}${ids.length > 6 ? `<i>+${ids.length - 6}</i>` : ''}`;
  // One row layout for sessions, earlier days and the column header, so everything lines up.
  const row = ({ key, open, active, id, time, len, chars, systems, units, rate, sv, approx = false, ms = 0, pre = 0 }) => `
    <div class="sess${active ? ' active' : ''}${open ? ' open' : ''}" data-key="${key}">
      <button class="sess-head cols${approx ? ' approx' : ''}" ${cs} aria-expanded="${open}">
        <span class="c-id">${id}</span><span class="c-time">${time}</span><span class="c-len">${len}</span>
        <span class="c-who">${who(chars)}</span><span class="c-sys">${esc(systems.map(sysName).join(', '))}</span>
        <span class="c-units"${pre ? ` title="Includes ${num(pre)} units mined earlier that day, before tracking started"` : ''}>${num(units)}${pre ? '<sup>+</sup>' : ''}</span><span class="c-rate">${rate == null ? '' : isk(rate)}</span>
        <span class="c-val">${isk(sv.v)}${sv.missing ? '*' : ''}</span>${bbs().map((b, i) => `<span class="c-bb" data-l="${esc(b.short)}">${bbNote(sv, i, { short: false })}${ms > 0 ? `<small>${isk(perHr((sv.r || sv).bb[i], ms))}/hr</small>` : ''}</span>`).join('')}
      </button>
      ${open ? `<div class="sess-body">${approx ? '' : rateStrip(sv)}${breakdown(sv.rows)}</div>` : ''}
    </div>`;
  const rows = sessions.map(s => row({
    key: String(s.first), open: state.open.has(String(s.first)), active: s.active,
    id: `<b class="sid">${s.id}</b>`, time: `${evetime(s.start)}–${s.active ? 'now' : evetime(s.end)}`, len: dur(s.ms),
    chars: s.chars, systems: s.systems, units: s.units, rate: perHr(s.r.v, s.ms), sv: s, ms: s.ms, pre: s.pre,
  })).join('');
  const header = (first = 'Session ID', time = 'EVE time') => `<div class="cols colhead" ${cs}><span class="c-id">${first}</span><span class="c-time">${time}</span><span class="c-len">Length</span><span class="c-who">Characters</span><span class="c-sys">Systems</span><span class="c-units">Units</span><span class="c-rate">ISK/hr</span><span class="c-val">Your value</span>${bbs().map(b => `<span class="c-bb" title="${esc(b.name)}">${esc(b.short)}</span>`).join('')}</div>`;
  const approxDays = [...new Set(approx.map(e => e.d))].sort().reverse();
  const earlier = approx.length ? `<h3 class="sub">Before tracking started</h3>
    <p class="hint">Mining from the 30 days of history EVE had when each character was added. EVE only gives daily totals for these, so there's no session time or ISK/hr.</p>
    ${header('Day', '')}<div class="sessions${bb ? ' with-bb' : ''}">${approxDays.map(d => { const r = approx.filter(e => e.d === d); const key = `a${d}`;
      return row({ key, open: state.open.has(key), approx: true, id: `<b>${idDate(Date.parse(d + 'T12:00:00Z'))}</b>`, time: 'whole day', len: '',
        chars: [...new Set(r.map(e => e.c))], systems: [...new Set(r.map(e => e.s))], units: r.reduce((n, e) => n + e.q, 0), rate: null, sv: { ...sumValue(r), rows: r } }); }).join('')}</div>` : '';
  const head = header();
  return `${tiles()}${toolbar}${head}<div class="sessions${bb ? ' with-bb' : ''}">${rows || '<p class="hint">No timed sessions in this range yet.</p>'}</div>${earlier}${priceLine()}`;
}

function viewHistory() {
  if (!state.allEvents) { loadHistory().then(render).catch(e => toast(e.message, true)); return '<div class="empty"><p>Loading every session…</p></div>'; }
  const all = buildSessions(state.allEvents);
  const q = state.hq.trim().toLowerCase();
  const list = q ? all.filter(s => [s.id, evedate(s.start), ...s.chars.map(charName), ...s.systems.map(sysName)].some(x => String(x).toLowerCase().includes(q))) : all;
  const bb = showBB();
  const hours = list.reduce((n, s) => n + s.ms, 0) / 3600e3;
  const add = get => ({ v: list.reduce((n, s) => n + get(s).v, 0), bb: bbs().map((b, i) => list.reduce((n, s) => n + get(s).bb[i], 0)), best: list.reduce((n, s) => n + get(s).best, 0) });
  const tot = add(s => s), timedTot = add(s => s.r);
  const rows = list.map(s => {
    const open = state.open.has(`h${s.first}`), rate = perHr(s.r.v, s.ms);
    return `<tr class="hrow${open ? ' open' : ''}${s.active ? ' active' : ''}" data-hkey="h${s.first}">
      <td><b class="sid">${s.id}</b>${s.active ? ' <span class="live">active</span>' : ''}</td>
      <td class="nowrap">${evetime(s.start)}–${s.active ? 'now' : evetime(s.end)}</td><td class="nowrap">${dur(s.ms)}</td>
      <td class="who">${s.chars.slice(0, 6).map(c => portrait(c, 20)).join('')}${s.chars.length > 6 ? ` +${s.chars.length - 6}` : ''} <span class="dim">${s.chars.length}</span></td>
      <td class="dim ell">${esc(s.systems.map(sysName).join(', '))}</td>
      <td class="r"${s.pre ? ` title="Includes ${num(s.pre)} units mined earlier that day, before tracking started"` : ''}>${num(s.units)}${s.pre ? '<sup>+</sup>' : ''}</td><td class="r dim">${isk(rate)}</td><td class="r val">${isk(s.v)}${s.missing ? '*' : ''}</td>
      ${bbTds(s, s.ms)}</tr>
      ${open ? `<tr class="hbody"><td colspan="${8 + bbs().length}">${rateStrip(s)}${breakdown(s.rows)}</td></tr>` : ''}`;
  }).join('');
  return `<div class="toolbar"><input type="search" id="hq" placeholder="Search by session ID, date, character or system" value="${esc(state.hq)}"><span class="grow"></span><button id="hcsv">Export sessions CSV</button></div>
    <div class="tiles">
      <div class="tile"><span>Sessions</span><b>${list.length}</b><i>${hours.toFixed(1)} hours mining</i></div>
      <div class="tile"><span>Total value</span><b>${isk(tot.v)}</b>${bbLines(tot)}</div>
      <div class="tile"><span>Average ISK/hr</span><b>${isk(hours ? timedTot.v / hours : null)}</b>${bbs().map((b, i) => `<i class="bb">${esc(b.short)} ${isk(hours ? timedTot.bb[i] / hours : null)}</i>`).join('')}</div>
    </div>
    ${list.length ? `<div class="scroll"><table class="grid hist"><thead><tr><th>Session ID</th><th>EVE time</th><th>Length</th><th>Characters</th><th>Systems</th><th class="r">Units</th><th class="r">ISK/hr</th><th class="r">Your value</th>${bbHeads()}</tr></thead><tbody>${rows}</tbody></table></div>`
      : `<div class="empty"><p>${q ? 'No sessions match that search.' : 'No timed sessions yet.'}</p></div>`}
    <p class="hint">Session IDs are the EVE (UTC) date a session started plus its number that day, e.g. 22NOV2026-S01. They're worked out from your mining entries, so they stay the same as long as the session gap setting (${state.me.settings.session_gap_minutes} min) isn't changed. Mining from before tracking started has no times, so it isn't in this list.</p>
    ${priceLine()}`;
}

function exportSessionsCsv() {
  const col = b => `${b.short.replace(/[^\w]/g, '').toLowerCase() || 'buyback'}_isk`;
  const q = state.hq.trim().toLowerCase();
  const list = buildSessions(state.allEvents || []).filter(s => !q || [s.id, evedate(s.start), ...s.chars.map(charName), ...s.systems.map(sysName)].some(x => String(x).toLowerCase().includes(q)));
  const head = ['session_id', 'start_eve', 'end_eve', 'minutes', 'characters', 'systems', 'units', 'isk', 'isk_per_hour', 'isk_per_hour_per_character',
    ...bbs().flatMap(b => [col(b), col(b).replace(/_isk$/, '_isk_per_hour')]), ...(bbs().length > 1 ? ['best_split_isk', 'best_split_isk_per_hour'] : []), 'units_before_tracking'];
  const fmt = ms => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
  const fx = x => x == null || !isFinite(x) ? '' : x.toFixed(2);
  const lines = list.reverse().map(s => [s.id, fmt(s.start), s.active ? '' : fmt(s.end), Math.round(s.ms / 60e3), s.chars.map(charName).join('; '), s.systems.map(sysName).join('; '),
    s.units, s.v.toFixed(2), fx(perHr(s.r.v, s.ms)), fx(perHr(s.r.v, s.ms) / s.chars.length),
    ...s.bb.flatMap((x, i) => [x.toFixed(2), fx(perHr(s.r.bb[i], s.ms))]), ...(bbs().length > 1 ? [s.best.toFixed(2), fx(perHr(s.r.best, s.ms))] : []), s.pre]);
  download(`miningledger-sessions-${evedate(Date.now())}.csv`, [head, ...lines]);
}
function download(name, rows) {
  const csv = rows.map(r => r.map(x => /[",\n]/.test(String(x)) ? `"${String(x).replace(/"/g, '""')}"` : x).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = name; a.click(); URL.revokeObjectURL(a.href);
}

function viewDays() {
  const byDay = new Map();
  for (const e of state.events) { if (!byDay.has(e.d)) byDay.set(e.d, []); byDay.get(e.d).push(e); }
  const days = [...byDay].sort((a, b) => b[0].localeCompare(a[0])).map(([d, r]) => ({ d, r, ...sumValue(r), units: r.reduce((n, e) => n + e.q, 0) }));
  const max = Math.max(1, ...days.map(d => d.v));
  let running = days.reduce((n, d) => n + d.v, 0);
  const body = days.map(d => { const line = `<tr><td><b>${d.d}</b></td><td class="bar"><i style="width:${(d.v / max * 100).toFixed(1)}%"></i></td>
    <td class="r">${num(d.units)}</td><td class="r">${isk(d.v)}</td>${bbTds(d)}<td class="r dim">${isk(running)}</td></tr>`; running -= d.v; return line; }).join('');
  return `${tiles()}<div class="toolbar">${rangePicker()}<span class="grow"></span><button id="csv">Export CSV</button></div>
    ${days.length ? `<table class="grid days"><thead><tr><th>Day (EVE)</th><th></th><th class="r">Units</th><th class="r">ISK</th>${bbHeads()}<th class="r">Cumulative</th></tr></thead><tbody>${body}</tbody></table>` : '<div class="empty"><p>No ice in this range.</p></div>'}
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
      <td class="r">${isk(t.v)}${bbs().map((b, i) => `<div class="bb">${bbNote(t, i)}</div>`).join('')}</td>
      <td class="r">${c.is_main ? '' : `<button class="link" data-main="${c.character_id}">Make main</button> <button class="link bad" data-remove="${c.character_id}">Remove</button>`}</td></tr>`;
  }).join('');
  return `<div class="toolbar"><a class="btn primary" href="/auth/login?add=1">+ Add a character</a><span class="grow"></span><button id="pollNow">Check ESI now</button></div>
    <table class="grid chars"><thead><tr><th></th><th>Character</th><th>Ledger</th><th class="r">All-time ISK</th><th></th></tr></thead><tbody>${rows}</tbody></table>
    <p class="hint">Characters belong to one MiningLedger account only. A character already linked to someone else's account can't be added to yours, and logging in with any of your alts opens this account.
    To add an alt, use <b>Add a character</b> and pick it on the EVE login page (log out of EVE there first if it signs you straight back in as the same character).
    Removing a character deletes its mining entries from MiningLedger.</p>
    ${ledgerCheck()}`;
}

/** EVE's daily ice totals per character next to what MiningLedger recorded (last 7 days), for checking against the game. */
function ledgerCheck() {
  if (!state.check) { api('/api/ledger-check').then(r => { state.check = r; if (state.tab === 'characters') render(); }).catch(e => toast(e.message, true)); return '<h3 class="sub">Ledger check</h3><p class="hint">Loading…</p>'; }
  const rows = state.check.map(r => {
    const ok = r.esi != null && r.esi === r.ours;
    return `<tr><td>${r.d}</td><td>${portrait(r.c, 20)} ${esc(charName(r.c))}</td><td>${typeIcon(r.y)} ${esc(ICE[r.y]?.name ?? r.y)}</td>
      <td class="r">${r.esi == null ? '—' : num(r.esi)}</td><td class="r">${num(r.ours)}</td><td class="r dim">${r.pre ? num(r.pre) : ''}</td>
      <td>${ok ? '<span class="ok">matches</span>' : `<span class="na">${r.esi == null ? 'not in EVE ledger' : `off by ${num(r.ours - r.esi)}`}</span>`}</td></tr>`;
  }).join('');
  return `<h3 class="sub">Ledger check (last 7 days)</h3>
    <p class="hint">EVE's own daily ice totals for each character, as last read from ESI, next to what MiningLedger has recorded. Compare the EVE column with your in-game mining ledger. "Before tracking" is the part loaded from history when the character was added (EVE gives day totals for that, with no times). Any mismatch is corrected at the character's next check.</p>
    ${state.check.length ? `<div class="scroll"><table class="grid"><thead><tr><th>Day (EVE)</th><th>Character</th><th>Ice</th><th class="r">EVE ledger</th><th class="r">MiningLedger</th><th class="r">Before tracking</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="hint">No ice in the last 7 days.</p>'}`;
}

function viewSettings() {
  const s = state.me.settings;
  if (!state.draftBuybacks) state.draftBuybacks = s.buybacks.map(b => ({ ...b, accepted: [...b.accepted] }));
  const draft = state.draftBuybacks, list = bbs();
  const rawOf = Object.fromEntries(Object.entries(ICE).map(([raw, t]) => [t.value, raw]));
  const priceRows = Object.entries(PRICED).map(([id, name]) => { const p = state.prices[id] || {}; const raw = rawOf[id];
    const pays = list.map(b => accepted(b, raw) ? bbValue(b, raw, 1) : null);
    const top = Math.max(0, ...pays.filter(x => x != null));
    const cells = pays.map(x => `<td class="r">${x == null ? '<span class="na">not accepted</span>' : `<span class="${list.length > 1 && x === top ? 'top' : ''}">${num(x)}</span>`}</td>`).join('');
    return `<tr><td>${typeIcon(id)} ${esc(name)}</td><td class="r">${p.buy != null ? num(p.buy) : '—'}</td><td class="r">${p.sell != null ? num(p.sell) : '—'}</td><td class="r">${num(value(raw, 1))}</td>${cells}<td class="dim">${esc(p.note || '')}</td></tr>`; }).join('');
  const productRows = Object.entries(PRODUCTS).map(([id, name]) => { const p = state.prices[id] || {};
    return `<tr><td>${typeIcon(id)} ${esc(name)}</td><td class="r">${p.buy != null ? p.buy.toLocaleString('en-US') : '—'}</td><td class="r">${p.sell != null ? p.sell.toLocaleString('en-US') : '—'}</td><td class="dim">${esc(p.note || '')}</td></tr>`; }).join('');
  const bbForm = draft.map((b, i) => `<fieldset class="bbset" data-i="${i}">
      <legend><label><input type="checkbox" name="bb_enabled"${b.enabled ? ' checked' : ''}> <b>${esc(b.name)}</b></label> <button type="button" class="link bad" data-bbrm="${i}">Remove</button></legend>
      <label class="field">Name <input name="bb_name" value="${esc(b.name)}" maxlength="50" style="width:280px"> Short name <input name="bb_short" value="${esc(b.short)}" maxlength="8" style="width:80px"></label>
      <label class="field">Pays <input name="bb_pct" type="number" min="1" max="200" step="0.1" value="${b.percentage}"> % of refined value at
        <select name="bb_basis">${BUYBACK_BASES.map(x => `<option${x === b.basis ? ' selected' : ''}>${x}</option>`).join('')}</select>, refine yield <input name="bb_yield" type="number" min="50" max="100" step="0.1" value="${b.yield}"> %</label>
      <div class="field">Accepts:</div>
      <div class="accept">${Object.entries(ICE).map(([id, t]) => `<label><input type="checkbox" name="bb_acc" value="${id}"${b.accepted.includes(+id) ? ' checked' : ''}${MATERIALS[id] ? '' : ' disabled'}> ${esc(t.name)}</label>`).join('')}</div>
      <label class="field notefield">Notes <textarea name="bb_note" rows="2" maxlength="500">${esc(b.note || '')}</textarea></label>
    </fieldset>`).join('');
  return `<form id="settings" class="panel form">
      <h3>Ice value</h3>
      <label class="field">Price source <select name="price_source">${state.me.price_sources.map(p => `<option${p === s.price_source ? ' selected' : ''}>${esc(p)}</option>`).join('')}</select></label>
      <label class="field">Percentage of price <input name="percentage" type="number" min="1" max="200" step="0.1" value="${s.percentage}"> %</label>
      <p class="hint">Every unit of raw ice is valued as one unit of its compressed type (compression is 1:1). Azure Ice and Crystalline Icicle can't be compressed, so they use their own price. All days use today's price.</p>
      <h3>Sessions</h3>
      <label class="field">New session after a gap of <input name="session_gap_minutes" type="number" min="15" max="240" step="5" value="${s.session_gap_minutes}"> minutes</label>
      <p class="hint">EVE updates mining ledgers in batches, so entries arrive roughly every ${POLL_MINUTES} to 20 minutes while you mine. A gap shorter than 20 minutes will split one session into several.</p>
      <h3>Buybacks to compare</h3>
      <p class="hint" style="margin-top:0">Each buyback pays a percentage of the ice's refined value: the ice products it reprocesses into, priced at Jita, after the refine yield. Ice a buyback doesn't take counts as 0 for it. With more than one switched on, "Best split" is what you'd get selling each ice type to whichever pays most. Azure Ice and Crystalline Icicle have no refine data here, so no buyback takes them.</p>
      ${bbForm}
      ${draft.length < 5 ? '<button type="button" id="bbadd">+ Add a buyback</button>' : ''}
      <div><button class="primary" type="submit">Save</button></div>
    </form>
    <div class="panel"><h3>Jita prices and what each buyer pays (ISK per unit)</h3><div class="scroll-x"><table class="grid"><thead><tr><th>Type</th><th class="r">Buy</th><th class="r">Sell</th><th class="r">You (${esc(s.price_source)} × ${s.percentage}%)</th>${bbHeads()}<th></th></tr></thead><tbody>${priceRows}</tbody></table></div>
    ${list.length > 1 ? '<p class="hint">Bold: the buyback paying most for that ice.</p>' : ''}
    <h3>Ice products</h3><table class="grid"><thead><tr><th>Type</th><th class="r">Buy</th><th class="r">Sell</th><th></th></tr></thead><tbody>${productRows}</tbody></table>
    <p class="hint">Highest buy and lowest sell order at Jita IV - Moon 4 - Caldari Navy Assembly Plant, refreshed hourly${state.pricesUpdated ? `, last ${ago(state.pricesUpdated)}` : ''}.</p></div>`;
}

/** Reads the buyback fieldsets back into the draft list (so Add/Remove keep unsaved edits). */
function readBuybacks() {
  return [...document.querySelectorAll('fieldset.bbset')].map(fs => {
    const v = n => fs.querySelector(`[name=${n}]`);
    return { enabled: v('bb_enabled').checked, name: v('bb_name').value, short: v('bb_short').value, percentage: Number(v('bb_pct').value),
      basis: v('bb_basis').value, yield: Number(v('bb_yield').value), note: v('bb_note').value,
      accepted: [...fs.querySelectorAll('[name=bb_acc]:checked')].map(x => Number(x.value)) };
  });
}

function render() {
  if (!state.me?.logged_in) return;
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === state.tab));
  $('#view').innerHTML = { sessions: viewSessions, history: viewHistory, days: viewDays, characters: viewCharacters, settings: viewSettings }[state.tab]();
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
  const col = b => `${b.short.replace(/[^\w]/g, '').toLowerCase() || 'buyback'}_isk`;
  const ids = new Map();
  for (const ss of buildSessions(state.events)) for (const r of ss.rows) ids.set(r, ss.id);
  const head = ['session_id', 'eve_time', 'date', 'character', 'system', 'ice', 'units', 'valued_as', 'unit_price', 'isk', ...bbs().map(col), 'time_known'];
  const lines = [...state.events].sort((a, b) => a.t - b.t).map(e => {
    const v = value(e.y, e.q), p = state.prices[ICE[e.y].value];
    const unit = p ? (s.price_source === 'Jita Sell' ? p.sell : p.buy) : '';
    return [ids.get(e) || '', e.a ? '' : new Date(e.t).toISOString().slice(0, 16).replace('T', ' '), e.d, charName(e.c), sysName(e.s), ICE[e.y].name, e.q, PRICED[ICE[e.y].value], unit ?? '', v == null ? '' : v.toFixed(2), ...bbs().map(b => accepted(b, e.y) ? (bbValue(b, e.y, e.q) ?? 0).toFixed(2) : 'not accepted'), e.a ? 'day only' : 'yes'];
  });
  download(`miningledger-${evedate(Date.now())}.csv`, [head, ...lines]);
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
  if (t.matches('#tabs button')) { state.tab = t.dataset.tab; state.draftBuybacks = null; render(); return; }
  if (t.id === 'bbadd') { state.draftBuybacks = [...readBuybacks(), { ...BUYBACK_DEFAULTS, accepted: [] }]; render(); return; }
  if (t.dataset.bbrm != null) {
    const d = readBuybacks(); const b = d[+t.dataset.bbrm];
    if (!confirm(`Remove ${b.name}? (Not saved until you press Save.)`)) return;
    d.splice(+t.dataset.bbrm, 1); state.draftBuybacks = d; render(); return;
  }
  if (t.dataset.go) { e.preventDefault(); state.tab = t.dataset.go; render(); return; }
  if (t.classList.contains('sess-head')) { const k = t.parentElement.dataset.key; state.open.has(k) ? state.open.delete(k) : state.open.add(k); render(); return; }
  if (t.id === 'csv') { exportCsv(); return; }
  if (t.id === 'hcsv') { exportSessionsCsv(); return; }
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
document.addEventListener('click', e => {
  const row = e.target.closest('tr.hrow');
  if (!row || e.target.closest('a, button')) return;
  const k = row.dataset.hkey; state.open.has(k) ? state.open.delete(k) : state.open.add(k); render();
});
document.addEventListener('input', e => {
  if (e.target.id !== 'hq') return;
  state.hq = e.target.value;
  const pos = e.target.selectionStart; render();
  const el = $('#hq'); el.focus(); el.setSelectionRange(pos, pos);
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
      buybacks: readBuybacks(),
    }) });
    state.me.settings = settings; state.draftBuybacks = null; toast('Settings saved'); render();
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
