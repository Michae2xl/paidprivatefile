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

Polls `z_listunspent` and reports each note to `/api/webhooks/zcash`. The app settles
only when `amount >= price` and `confirmations >= PAID_PRIVATE_FILE_ZCASH_MIN_CONFIRMATIONS`.

## Verify on first real payment

The app matches a note to an order by **receiving address** (the per-order UA). On the
first testnet payment, confirm `z_listunspent`'s `note.address` equals the UA the buyer
paid. If Zallet reports a different address representation, switch matching to a per-order
**memo** (zcap-voting matches by `account_uuid` + `memoStr`) — a small webhook + watcher change.

## Activation order (coordinated with the app)

1. App secrets set: `PAID_PRIVATE_FILE_ZCASH_POOL_SECRET`, `_WEBHOOK_SECRET`, `_MIN_CONFIRMATIONS`.
2. Run the pool filler → addresses available.
3. App enables `PAID_PRIVATE_FILE_ZCASH_ONCHAIN=1` → payment intents assign pooled addresses.
4. Run the watcher → payments settle.
