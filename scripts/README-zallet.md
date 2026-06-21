# Local Zallet payment bridge (runs next to your wallet, e.g. on 192.168.0.28)

The wallet/keys stay on the machine running Zallet. These two scripts are the only
local pieces; they talk to Zallet's localhost RPC and push **HMAC-signed** reports to
the production app. Nothing else about the wallet leaves the machine.

Proven against Zallet `0.1.0-alpha.3` (RPC pattern mirrors the `zcap-voting` collector:
HTTP Basic auth + JSON-RPC 1.0; methods `z_getaddressforaccount`, `z_listunspent`).

## Env (on the wallet machine)

```bash
export ZALLET_RPC_URL=http://127.0.0.1:28232/
export ZALLET_RPC_USER=zcapanchor
export ZALLET_RPC_PASSWORD=...                 # the RPC password
export ZALLET_COLLECTOR_ACCOUNT=...            # Zallet account UUID that receives payouts
export PPF_API_URL=https://paidprivatefile-production.up.railway.app
export PPF_ZCASH_POOL_SECRET=...               # == app PAID_PRIVATE_FILE_ZCASH_POOL_SECRET
export PPF_ZCASH_WEBHOOK_SECRET=...            # == app PAID_PRIVATE_FILE_ZCASH_WEBHOOK_SECRET
```

Find the account UUID with `z_listaccounts` (or reuse zcap-voting's `POLL_COLLECTOR_ACCOUNT_UUID`).

## 1. Fill the deposit-address pool

```bash
POOL_BATCH=10 node scripts/zallet-pool-filler.mjs
```

Mints fresh per-order Unified Addresses (`z_getaddressforaccount(account, ["orchard"])`)
and registers them with the app. Re-run when the pool runs low.

## 2. Watch for incoming payments

```bash
node scripts/zallet-payment-watcher.mjs            # loops; Ctrl+C to stop
WATCH_ONCE=1 node scripts/zallet-payment-watcher.mjs   # single pass
```

Per-address query model (Zallet alpha.3's `z_listunspent` does **not** return the
per-note receiving address, but it accepts an `addresses` filter):

1. The watcher asks the app which per-order deposit addresses are live via the signed
   **watchlist** endpoint `POST /api/transfers/payments/zcash/watchlist` (body `{}`,
   signed with `PPF_ZCASH_POOL_SECRET` — the same secret the pool filler uses).
2. For each watched address it calls `z_listunspent(0, 9999999, true, [address])`.
3. Any unspent notes for that address are aggregated into one sighting (amount = sum of
   note values, confirmations = MIN across notes, txid = first note's txid) and reported
   to `/api/webhooks/zcash`, signed with `PPF_ZCASH_WEBHOOK_SECRET`.

The watcher therefore needs **both** `PPF_ZCASH_POOL_SECRET` (watchlist) and
`PPF_ZCASH_WEBHOOK_SECRET` (sightings). The app settles only when `amount >= price` and
`confirmations >= PAID_PRIVATE_FILE_ZCASH_MIN_CONFIRMATIONS`; identical
`address:txid:confirmations` sightings are de-duped within the process.

## Verify on first real payment

The app matches a sighting to an order by **receiving address** (the per-order UA the
watcher passed to `z_listunspent`'s `addresses` filter). On the first testnet payment,
confirm a note shows up when filtering by the UA the buyer paid. If a UA never returns
its note under the `addresses` filter, switch matching to a per-order **memo**
(zcap-voting matches by `account_uuid` + `memoStr`) — a small webhook + watcher change.

## Activation order (coordinated with the app)

1. App secrets set: `PAID_PRIVATE_FILE_ZCASH_POOL_SECRET`, `_WEBHOOK_SECRET`, `_MIN_CONFIRMATIONS`.
2. Run the pool filler → addresses available.
3. App enables `PAID_PRIVATE_FILE_ZCASH_ONCHAIN=1` → payment intents assign pooled addresses.
4. Run the watcher → payments settle.
