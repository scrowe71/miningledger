# MiningLedger

Ice mining ISK across your EVE Online main and alts, at **miningledger.crankyape.space**.

- Log in with your main, then **Characters → Add a character** for each alt. A character belongs to one account only;
  logging in with any of your alts opens your account, and nobody else can add them.
- Every 10 minutes the Worker reads each character's ESI mining ledger and records new ice. Entries are grouped into
  sessions across all characters, split by a configurable gap (default 30 minutes).
- Ice is valued as its **compressed** type (1:1) at **today's** Jita price (buy or sell, your choice) × your percentage
  (default 95%). Azure Ice and Crystalline Icicle have no compressed form and use their own price.
- The first check of a new character loads its last 30 days of history as day totals (no session times).

## Setup (one time)

1. **EVE app** at https://developers.eveonline.com: create an application, callback
   `https://miningledger.crankyape.space/auth/callback`, scope `esi-industry.read_character_mining.v1`.
   Put its Client ID in `wrangler.toml` (`EVE_CLIENT_ID`).
2. **D1 database** in Cloudflare (Storage & Databases → D1 → Create, name `miningledger`); paste its ID into `wrangler.toml`.
3. **Worker**: Workers & Pages → Create → Import a repository → `miningledger`. Deploy command `npx wrangler deploy`.
4. **Secret**: Worker → Settings → Variables and Secrets → Add → Secret, name `TOKEN_KEY`, value a long random string
   (encrypts the stored EVE refresh tokens; changing it later means every character has to log in again).
5. **Domain**: Worker → Settings → Domains & Routes → Add → Custom domain `miningledger.crankyape.space`.

Tables are created automatically. Prices load on first visit, then hourly at 5 past.

## Files

- `src/worker.js`: login (EVE SSO with PKCE, no client secret), account-scoped API, static files
- `src/poll.js`: mining ledger checks and Jita prices (scheduled)
- `src/tokens.js`: encrypted refresh tokens; `src/jwt.js`: EVE token verification; `src/db.js`: schema
- `public/`: the web app; `public/ice.js` is the ice type table shared with the Worker
