#!/usr/bin/env node
// Zallet payment watcher (runs LOCALLY next to your Zallet wallet, e.g. on 192.168.0.28).
//
// Polls Zallet's `z_listunspent` for incoming notes and reports each one to the
// production app's HMAC-signed webhook. The app matches the note's address to an
// order's per-order deposit address and settles only when amount >= price and
// confirmations >= the app's minimum (the app does the verification; this script
// only relays signed sightings). The wallet/keys never leave this machine.
//
// RPC pattern (HTTP Basic auth + JSON-RPC 1.0) mirrors the proven zcap-voting client.
//
// Env:
//   ZALLET_RPC_URL            e.g. http://127.0.0.1:28232/
//   ZALLET_RPC_USER           e.g. zcapanchor
//   ZALLET_RPC_PASSWORD       the RPC password
//   ZALLET_COLLECTOR_ACCOUNT  (optional) account UUID to filter notes to the payout account
//   PPF_API_URL               e.g. https://paidprivatefile-production.up.railway.app
//   PPF_ZCASH_WEBHOOK_SECRET  must equal the app's PAID_PRIVATE_FILE_ZCASH_WEBHOOK_SECRET
//   WATCH_INTERVAL_MS         poll interval (default 20000)
//
// Usage:  node scripts/zallet-payment-watcher.mjs        (loops; Ctrl+C to stop)
//         WATCH_ONCE=1 node scripts/zallet-payment-watcher.mjs   (single pass)

import { createHmac } from "node:crypto";

const RPC_URL = requireEnv("ZALLET_RPC_URL");
const RPC_USER = process.env.ZALLET_RPC_USER ?? "";
const RPC_PASSWORD = process.env.ZALLET_RPC_PASSWORD ?? "";
const ACCOUNT = process.env.ZALLET_COLLECTOR_ACCOUNT ?? "";
const API_URL = requireEnv("PPF_API_URL").replace(/\/+$/u, "");
const WEBHOOK_SECRET = requireEnv("PPF_ZCASH_WEBHOOK_SECRET");
const INTERVAL_MS = Number(process.env.WATCH_INTERVAL_MS ?? "20000");
const ONCE = process.env.WATCH_ONCE === "1";

// Skip re-reporting an identical (txid:address:confirmations) sighting.
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

async function reportNote(note) {
  const report = {
    receivingAddress: note.address,
    amountZats: noteAmountZats(note),
    txid: note.txid,
    confirmations: typeof note.confirmations === "number" ? note.confirmations : 0,
  };
  const body = JSON.stringify(report);
  const signature = createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");
  const response = await fetch(`${API_URL}/api/webhooks/zcash`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-zcash-signature": signature },
    body,
  });
  const text = await response.text();
  console.log(
    `note ${report.txid.slice(0, 12)}… addr=${report.receivingAddress.slice(0, 14)}… ` +
      `${report.amountZats} zats conf=${report.confirmations} -> HTTP ${response.status} ${text}`,
  );
}

async function pass() {
  // minconf=0 so we report unconfirmed notes too; the app withholds settlement
  // until confirmations reach its minimum, and keeps the order retryable.
  const notes = await callRpc("z_listunspent", [0, 9999999, true]);
  let reported = 0;
  for (const note of Array.isArray(notes) ? notes : []) {
    if (!note || typeof note.address !== "string" || typeof note.txid !== "string") {
      continue;
    }
    if (ACCOUNT && note.account_uuid && note.account_uuid !== ACCOUNT) {
      continue;
    }
    const key = `${note.txid}:${note.address}:${note.confirmations ?? 0}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    try {
      await reportNote(note);
      reported += 1;
    } catch (error) {
      console.error(`  report failed for ${note.txid}: ${error.message}`);
      seen.delete(key); // allow retry next pass
    }
  }
  if (reported === 0) {
    console.log("no new notes");
  }
}

async function main() {
  console.log(`watching ${RPC_URL} -> ${API_URL}/api/webhooks/zcash (interval ${INTERVAL_MS}ms)`);
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
