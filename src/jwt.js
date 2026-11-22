// Verifies an EVE SSO access token (a JWT signed by CCP) inside the Worker.
// Returns { id, name, scopes } or throws an Error with .status = 401.

const JWKS_URL = 'https://login.eveonline.com/oauth/jwks';
const ISSUERS = ['login.eveonline.com', 'https://login.eveonline.com'];
let jwksCache = null;   // { keys, ts }

const b64urlBytes = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4)), c => c.charCodeAt(0));
const b64urlJson = s => JSON.parse(new TextDecoder().decode(b64urlBytes(s)));
const fail = msg => Object.assign(new Error(msg), { status: 401 });

async function getKeys(fetchImpl, force = false) {
  if (!force && jwksCache && Date.now() - jwksCache.ts < 6 * 3600e3) return jwksCache.keys;
  const r = await fetchImpl(JWKS_URL);
  if (!r.ok) throw Object.assign(new Error('Could not reach EVE login to check your token'), { status: 502 });
  jwksCache = { keys: (await r.json()).keys || [], ts: Date.now() };
  return jwksCache.keys;
}

export function bearer(request) {
  const h = request.headers.get('Authorization') || '';
  const m = h.match(/^Bearer\s+([A-Za-z0-9._-]+)$/);
  if (!m) throw fail('Log in with EVE first');
  return m[1];
}

export async function verifyEveToken(token, env = {}, fetchImpl = fetch) {
  const parts = token.split('.');
  if (parts.length !== 3) throw fail('Malformed token');
  let header, payload;
  try { header = b64urlJson(parts[0]); payload = b64urlJson(parts[1]); } catch { throw fail('Malformed token'); }
  if (header.alg !== 'RS256') throw fail('Unexpected token type');

  let keys = await getKeys(fetchImpl);
  let jwk = keys.find(k => k.kid === header.kid && k.alg === 'RS256');
  if (!jwk) { keys = await getKeys(fetchImpl, true); jwk = keys.find(k => k.kid === header.kid && k.alg === 'RS256'); }
  if (!jwk) throw fail('Unknown signing key');

  const key = await crypto.subtle.importKey('jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlBytes(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!ok) throw fail('Token signature is not valid');

  if (!ISSUERS.includes(payload.iss)) throw fail('Token was not issued by EVE');
  if (!payload.exp || payload.exp * 1000 < Date.now()) throw fail('Token expired; refresh and try again');
  const aud = [].concat(payload.aud || []);
  if (!aud.includes('EVE Online')) throw fail('Token audience is wrong');
  if (env.CLIENT_ID && !aud.includes(env.CLIENT_ID)) throw fail('Token belongs to a different application');
  const m = String(payload.sub || '').match(/^CHARACTER:EVE:(\d+)$/);
  if (!m) throw fail('Token is not for a character');

  return { id: Number(m[1]), name: payload.name, scopes: [].concat(payload.scp || []) };
}
