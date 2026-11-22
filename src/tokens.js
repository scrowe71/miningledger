// EVE login tokens: refresh tokens are stored encrypted (AES-GCM, key from the TOKEN_KEY secret).
const SSO_TOKEN = 'https://login.eveonline.com/v2/oauth/token';
export const err = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });

const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
let keyCache = null;
async function aesKey(env) {
  if (!env.TOKEN_KEY || String(env.TOKEN_KEY).length < 16) throw err(503, 'Not set up yet: add a TOKEN_KEY secret (16+ characters) to this Worker (see README).');
  if (keyCache?.src === env.TOKEN_KEY) return keyCache.key;
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(env.TOKEN_KEY));
  keyCache = { src: env.TOKEN_KEY, key: await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']) };
  return keyCache.key;
}
export async function encrypt(env, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(env), new TextEncoder().encode(text));
  return `${b64(iv)}.${b64(ct)}`;
}
export async function decrypt(env, blob) {
  const [iv, ct] = String(blob).split('.');
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, await aesKey(env), unb64(ct)));
}
export const jwtExp = t => JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).exp * 1000;

export async function tokenRequest(env, params, fetchImpl = fetch) {
  const r = await fetchImpl(SSO_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...params, client_id: env.EVE_CLIENT_ID }),
  });
  if (!r.ok) {
    const bad = r.status === 400 || r.status === 401;
    throw err(bad ? 401 : 502, `EVE login ${params.grant_type === 'refresh_token' ? 'refresh' : 'exchange'} failed (${r.status})`, { needsLogin: bad });
  }
  return r.json();
}

/** A valid access token for a character, refreshing (and re-encrypting the rotated refresh token) if needed. */
export async function accessToken(env, row, fetchImpl = fetch) {
  if (row.access_token && row.access_exp - 60_000 > Date.now()) return row.access_token;
  try {
    const tok = await tokenRequest(env, { grant_type: 'refresh_token', refresh_token: await decrypt(env, row.refresh_enc) }, fetchImpl);
    const enc = tok.refresh_token ? await encrypt(env, tok.refresh_token) : row.refresh_enc;
    await env.DB.prepare('UPDATE characters SET access_token = ?, access_exp = ?, refresh_enc = ?, needs_login = 0 WHERE character_id = ?')
      .bind(tok.access_token, jwtExp(tok.access_token), enc, row.character_id).run();
    return tok.access_token;
  } catch (e) {
    if (e.needsLogin) await env.DB.prepare('UPDATE characters SET needs_login = 1, last_error = ? WHERE character_id = ?').bind('EVE login expired: log this character in again', row.character_id).run();
    throw e;
  }
}
