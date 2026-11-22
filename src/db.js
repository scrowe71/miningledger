// D1 schema, created automatically on first use.
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS accounts (
     id INTEGER PRIMARY KEY, main_character_id INTEGER NOT NULL, settings TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS characters (
     character_id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL, name TEXT NOT NULL,
     refresh_enc TEXT NOT NULL, access_token TEXT, access_exp INTEGER NOT NULL DEFAULT 0,
     needs_login INTEGER NOT NULL DEFAULT 0, added_at INTEGER NOT NULL,
     last_poll INTEGER NOT NULL DEFAULT 0, last_error TEXT)`,
  `CREATE INDEX IF NOT EXISTS ix_characters_account ON characters (account_id)`,
  `CREATE TABLE IF NOT EXISTS logins (id TEXT PRIMARY KEY, account_id INTEGER NOT NULL, expires INTEGER NOT NULL)`,
  // Running daily totals from ESI, used to work out what's new since the last check.
  `CREATE TABLE IF NOT EXISTS ledger_totals (
     character_id INTEGER NOT NULL, date TEXT NOT NULL, solar_system_id INTEGER NOT NULL, type_id INTEGER NOT NULL,
     quantity INTEGER NOT NULL, PRIMARY KEY (character_id, date, solar_system_id, type_id))`,
  // Ice newly seen at a check. approx = 1 for history that existed before tracking started (day known, time not).
  `CREATE TABLE IF NOT EXISTS mining_events (
     id INTEGER PRIMARY KEY AUTOINCREMENT, character_id INTEGER NOT NULL, at INTEGER NOT NULL, date TEXT NOT NULL,
     solar_system_id INTEGER NOT NULL, type_id INTEGER NOT NULL, quantity INTEGER NOT NULL, approx INTEGER NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS ix_events_char_at ON mining_events (character_id, at)`,
  `CREATE TABLE IF NOT EXISTS prices (type_id INTEGER PRIMARY KEY, buy REAL, sell REAL, note TEXT, updated INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
];
let ready = null;
export const ensureSchema = db => (ready ??= db.batch(SCHEMA.map(s => db.prepare(s))).catch(e => { ready = null; throw e; }));
export async function getMeta(db, key) {
  const r = await db.prepare('SELECT value FROM meta WHERE key = ?').bind(key).first();
  return r ? r.value : null;
}
export const setMeta = (db, key, value) =>
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(key, String(value));
