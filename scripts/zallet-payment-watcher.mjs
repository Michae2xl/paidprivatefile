#!/usr/bin/env node
// Zallet payment watcher (runs LOCALLY next to your Zallet wallet, e.g. on 192.168.0.28).
//
// Per-address query model: Zallet alpha.3's `z_listunspent` does NOT return the
// per-note receiving address (only account_uuid/value/memo/txid/confirmations), but
// it accepts an `addresses` filter. So this watcher asks the production app which
// per-order deposit addresses are live (the HMAC-signed watchlist endpoint) and then
// queries `z_listunspent` once PER address. Any unspent notes for an address are
// aggregated into a single signed sighting and reported to the app's webhook, which
// maps the address to its order and settles only when amount >= price and
// confirmations >= the app's minimum (the app does the verification; this script
// only relays signed sightings). The wallet/keys never leave this machine.
//
// RPC pattern (HTTP Basic auth + JSON-RPC 1.0) mirrors the proven zcap-voting client.
//
// Env:
//   ZALLET_RPC_URL            e.g. http://127.0.0.1:28232/
//   ZALLET_RPC_USER           e.g. zcapanchor
//   ZALLET_RPC_PASSWORD       the RPC password
//   PPF_API_URL               e.g. https://paidprivatefile-production.up.railway.app
//   PPF_ZCASH_POOL_SECRET     must equal the app's PAID_PRIVATE_FILE_ZCASH_POOL_SECRET (for the watchlist)
//   PPF_ZCASH_WEBHOOK_SECRET  must equal the app's PAID_PRIVATE_FILE_ZCASH_WEBHOOK_SECRET (for sightings)
//   WATCH_INTERVAL_MS         poll interval (default 20000)
//
// Usage:  node scripts/zallet-payment-watcher.mjs        (loops; Ctrl+C to stop)
//         WATCH_ONCE=1 node scripts/zallet-payment-watcher.mjs   (single pass)

import { createHmac } from "node:crypto";

const RPC_URL = requireEnv("ZALLET_RPC_URL");
const RPC_USER = process.env.ZALLET_RPC_USER ?? "";
const RPC_PASSWORD = process.env.ZALLET_RPC_PASSWORD ?? "";
const API_URL = requireEnv("PPF_API_URL").replace(/\/+$/u, "");
const POOL_SECRET = requireEnv("PPF_ZCASH_POOL_SECRET");
const WEBHOOK_SECRET = requireEnv("PPF_ZCASH_WEBHOOK_SECRET");
const INTERVAL_MS = Number(process.env.WATCH_INTERVAL_MS ?? "20000");
const ONCE = process.env.WATCH_ONCE === "1";

// Skip re-reporting an identical (address:txid:confirmations) sighting.
const seen = new Set();

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env: ${name}`);
    process.exit(1);
  }
  return value;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function zecToZats(value) {
  const normalized = String(value ?? "0").trim();
  if (!/^\d+(\.\d+)?$/u.test(normalized)) {
    throw new Error(`invalid ZEC amount: ${normalized}`);
  }
  const [whole, fractional = ""] = normalized.split(".");
  return Number(BigInt(whole) * 100000000n + BigInt(fractional.padEnd(8, "0") || "0"));
}

function noteAmountZats(note) {
  if (note.valueZat !== undefined && note.valueZat !== null) {
    return Number(note.valueZat);
  }
  return zecToZats(note.value);
}

function hmacHex(secret, body) {
  return createHmac("sha256", secret).update(body).digest("hex");
}

async function callRpc(method, params) {
  const headers = { "content-type": "application/json" };
  if (RPC_USER) {
    headers.authorization =
      "Basic " + Buffer.from(`${RPC_USER}:${RPC_PASSWORD}`, "utf8").toString("base64");
  }
  const response = await fetch(RPC_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "1.0", id: "ppf-watch", method, params }),
  });
  if (!response.ok) {
    throw new Error(`${method} -> HTTP ${response.status}`);
  }
  const json = await response.json();
  if (json.error) {
    throw new Error(`${method}: ${json.error.message ?? "rpc error"}`);
  }
  return json.result;
}

// Ask the app which per-order deposit addresses are live and need watching.
async function fetchWatchlist() {
  const body = "{}";
  const signature = hmacHex(POOL_SECRET, body);
  const response = await fetch(`${API_URL}/api/transfers/payments/zcash/watchlist`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-zcash-signature": signature },
    body,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`watchlist -> HTTP ${response.status} ${text}`);
  }
  const json = await response.json();
  const addresses = Array.isArray(json.addresses) ? json.addresses : [];
  return addresses.filter((address) => typeof address === "string" && address);
}

// Query z_listunspent for a single deposit address and aggregate its notes into one
// sighting: amount = sum of note values, confirmations = MIN across notes (so the
// app withholds settlement until every note clears), txid = the first note's txid.
async function sightingForAddress(address) {
  const notes = await callRpc("z_listunspent", [0, 9999999, true, [address]]);
  const usable = (Array.isArray(notes) ? notes : []).filter(
    (note) => note && typeof note.txid === "string",
  );
  if (usable.length === 0) {
    return null;
  }

  let amountZats = 0;
  let confirmations = Infinity;
  for (const note of usable) {
    amountZats += noteAmountZats(note);
    const noteConf = typeof note.confirmations === "number" ? note.confirmations : 0;
    confirmations = Math.min(confirmations, noteConf);
  }

  return {
    receivingAddress: address,
    amountZats,
    txid: usable[0].txid,
    confirmations: Number.isFinite(confirmations) ? confirmations : 0,
  };
}

async function reportSighting(sighting) {
  const body = JSON.stringify(sighting);
  const signature = hmacHex(WEBHOOK_SECRET, body);
  const response = await fetch(`${API_URL}/api/webhooks/zcash`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-zcash-signature": signature },
    body,
  });
  const text = await response.text();
  console.log(
    `sighting addr=${sighting.receivingAddress.slice(0, 14)}… ` +
      `tx=${sighting.txid.slice(0, 12)}… ${sighting.amountZats} zats ` +
      `conf=${sighting.confirmations} -> HTTP ${response.status} ${text}`,
  );
}

async function pass() {
  const addresses = await fetchWatchlist();
  if (addresses.length === 0) {
    console.log("watchlist empty (no assigned deposit addresses)");
    return;
  }

  let reported = 0;
  for (const address of addresses) {
    let sighting;
    try {
      sighting = await sightingForAddress(address);
    } catch (error) {
      console.error(`  z_listunspent failed for ${address.slice(0, 14)}…: ${error.message}`);
      continue;
    }
    if (!sighting) {
      continue;
    }

    const key = `${sighting.receivingAddress}:${sighting.txid}:${sighting.confirmations}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    try {
      await reportSighting(sighting);
      reported += 1;
    } catch (error) {
      console.error(`  report failed for ${sighting.receivingAddress.slice(0, 14)}…: ${error.message}`);
      seen.delete(key); // allow retry next pass
    }
  }

  if (reported === 0) {
    console.log(`no new notes across ${addresses.length} watched address(es)`);
  }
}

async function main() {
  console.log(
    `watching ${RPC_URL} via per-address z_listunspent ` +
      `(watchlist + webhook -> ${API_URL}, interval ${INTERVAL_MS}ms)`,
  );
  for (;;) {
    try {
      await pass();
    } catch (error) {
      console.error("poll failed:", error.message);
    }
    if (ONCE) {
      break;
    }
    await sleep(INTERVAL_MS);
  }
}

main().catch((error) => {
  console.error("watcher failed:", error.message);
  process.exit(1);
});
