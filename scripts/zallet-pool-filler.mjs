#!/usr/bin/env node
// Zallet deposit-address pool filler (runs LOCALLY next to your Zallet wallet, e.g. on 192.168.0.28).
//
// Derives fresh per-order Unified Addresses from the seller/collector account via
// Zallet's `z_getaddressforaccount` and registers them with the production app's
// HMAC-signed pool endpoint. The wallet/keys never leave this machine.
//
// RPC pattern (HTTP Basic auth + JSON-RPC 1.0) mirrors the proven zcap-voting client.
//
// Env:
//   ZALLET_RPC_URL            e.g. http://127.0.0.1:28232/
//   ZALLET_RPC_USER           e.g. zcapanchor
//   ZALLET_RPC_PASSWORD       the RPC password
//   ZALLET_COLLECTOR_ACCOUNT  the Zallet account UUID that receives payouts
//   PPF_API_URL               e.g. https://paidprivatefile-production.up.railway.app
//   PPF_ZCASH_POOL_SECRET     must equal the app's PAID_PRIVATE_FILE_ZCASH_POOL_SECRET
//   POOL_BATCH                how many addresses to mint per run (default 10)
//
// Usage:  node scripts/zallet-pool-filler.mjs

import { createHmac } from "node:crypto";

const RPC_URL = requireEnv("ZALLET_RPC_URL");
const RPC_USER = process.env.ZALLET_RPC_USER ?? "";
const RPC_PASSWORD = process.env.ZALLET_RPC_PASSWORD ?? "";
const ACCOUNT = requireEnv("ZALLET_COLLECTOR_ACCOUNT");
const API_URL = requireEnv("PPF_API_URL").replace(/\/+$/u, "");
const POOL_SECRET = requireEnv("PPF_ZCASH_POOL_SECRET");
const BATCH = Number(process.env.POOL_BATCH ?? "10");

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env: ${name}`);
    process.exit(1);
  }
  return value;
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
    body: JSON.stringify({ jsonrpc: "1.0", id: "ppf-pool", method, params }),
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

async function main() {
  const addresses = [];
  for (let i = 0; i < BATCH; i += 1) {
    const result = await callRpc("z_getaddressforaccount", [ACCOUNT, ["orchard"]]);
    const address = result?.address;
    if (typeof address !== "string" || !address) {
      throw new Error("z_getaddressforaccount did not return an address");
    }
    addresses.push(address);
  }

  const body = JSON.stringify({ addresses });
  const signature = createHmac("sha256", POOL_SECRET).update(body).digest("hex");
  const response = await fetch(`${API_URL}/api/transfers/payments/zcash/addresses`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-zcash-signature": signature },
    body,
  });
  const text = await response.text();
  console.log(`registered ${addresses.length} address(es) -> HTTP ${response.status} ${text}`);
  if (!response.ok) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("pool-filler failed:", error.message);
  process.exit(1);
});
