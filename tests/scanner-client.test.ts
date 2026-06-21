import { createHmac } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createScannerClient,
  type ScannerFetch,
} from "../lib/server/scanner-client";

const SCANNER_URL = "https://scanner.test";
const SCANNER_SECRET = "test-scanner-secret";

interface CapturedRequest {
  url: string;
  method: string;
  body: string;
  signature: string;
}

function makeFetch(
  handler: (request: CapturedRequest) => {
    status?: number;
    json: unknown;
  },
): { fetch: ScannerFetch; calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = [];
  const fetchImpl: ScannerFetch = async (url, init) => {
    const headers = new Headers(init?.headers);
    const captured: CapturedRequest = {
      url: String(url),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : "",
      signature: headers.get("x-ppf-scanner-sig") ?? "",
    };
    calls.push(captured);
    const result = handler(captured);
    return new Response(JSON.stringify(result.json), {
      status: result.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { fetch: fetchImpl, calls };
}

beforeEach(() => {
  process.env.PPF_SCANNER_URL = SCANNER_URL;
  process.env.PPF_SCANNER_SECRET = SCANNER_SECRET;
});

afterEach(() => {
  delete process.env.PPF_SCANNER_URL;
  delete process.env.PPF_SCANNER_SECRET;
});

describe("scanner-client validateUfvk", () => {
  it("POSTs a signed body to /validate and returns the parsed response", async () => {
    const { fetch, calls } = makeFetch(() => ({
      json: {
        valid: true,
        network: "main",
        fingerprint: "f".repeat(64),
        defaultAddress: "u1default0000000000000000000000000000",
        receivers: ["orchard", "sapling", "transparent"],
        uaMatches: true,
      },
    }));
    const client = createScannerClient(fetch);

    const result = await client.validateUfvk({
      ufvk: "uview1abc",
      ua: "u1abc",
    });

    expect(result.valid).toBe(true);
    expect(result.network).toBe("main");
    expect(result.fingerprint).toBe("f".repeat(64));
    expect(result.defaultAddress).toBe("u1default0000000000000000000000000000");
    expect(result.receivers).toEqual(["orchard", "sapling", "transparent"]);
    expect(result.uaMatches).toBe(true);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${SCANNER_URL}/validate`);
    expect(calls[0].method).toBe("POST");
    const expectedSig = createHmac("sha256", SCANNER_SECRET)
      .update(calls[0].body)
      .digest("hex");
    expect(calls[0].signature).toBe(expectedSig);
    expect(JSON.parse(calls[0].body)).toEqual({
      ufvk: "uview1abc",
      ua: "u1abc",
    });
  });

  it("omits ua from the body when not provided", async () => {
    const { fetch, calls } = makeFetch(() => ({
      json: {
        valid: false,
        network: "test",
        fingerprint: "a".repeat(64),
        defaultAddress: "u1x",
        receivers: ["orchard"],
      },
    }));
    const client = createScannerClient(fetch);
    const result = await client.validateUfvk({ ufvk: "uview1abc" });

    expect(result.valid).toBe(false);
    expect(result.uaMatches).toBeUndefined();
    expect(JSON.parse(calls[0].body)).toEqual({ ufvk: "uview1abc" });
  });

  it("throws when the scanner returns a non-2xx status", async () => {
    const { fetch } = makeFetch(() => ({ status: 500, json: { error: "x" } }));
    const client = createScannerClient(fetch);
    await expect(client.validateUfvk({ ufvk: "uview1abc" })).rejects.toThrow();
  });

  it("throws when the scanner response is missing required fields", async () => {
    const { fetch } = makeFetch(() => ({ json: { valid: true } }));
    const client = createScannerClient(fetch);
    await expect(client.validateUfvk({ ufvk: "uview1abc" })).rejects.toThrow();
  });

  it("throws when PPF_SCANNER_URL is unset", async () => {
    delete process.env.PPF_SCANNER_URL;
    const { fetch } = makeFetch(() => ({ json: {} }));
    const client = createScannerClient(fetch);
    await expect(client.validateUfvk({ ufvk: "uview1abc" })).rejects.toThrow();
  });

  it("throws when PPF_SCANNER_SECRET is unset", async () => {
    delete process.env.PPF_SCANNER_SECRET;
    const { fetch } = makeFetch(() => ({ json: {} }));
    const client = createScannerClient(fetch);
    await expect(client.validateUfvk({ ufvk: "uview1abc" })).rejects.toThrow();
  });
});

describe("scanner-client deriveAddress", () => {
  it("POSTs a signed body to /derive and returns the address and actual index", async () => {
    const { fetch, calls } = makeFetch(() => ({
      json: { address: "u1derived00000000000000000000", actualIndex: 1234 },
    }));
    const client = createScannerClient(fetch);

    const result = await client.deriveAddress({
      ufvk: "uview1abc",
      diversifierIndex: 1230,
    });

    expect(result.address).toBe("u1derived00000000000000000000");
    expect(result.actualIndex).toBe(1234);
    expect(calls[0].url).toBe(`${SCANNER_URL}/derive`);
    expect(JSON.parse(calls[0].body)).toEqual({
      ufvk: "uview1abc",
      diversifierIndex: 1230,
    });
    const expectedSig = createHmac("sha256", SCANNER_SECRET)
      .update(calls[0].body)
      .digest("hex");
    expect(calls[0].signature).toBe(expectedSig);
  });

  it("throws when the derive response is malformed", async () => {
    const { fetch } = makeFetch(() => ({ json: { address: 123 } }));
    const client = createScannerClient(fetch);
    await expect(
      client.deriveAddress({ ufvk: "uview1abc", diversifierIndex: 1 }),
    ).rejects.toThrow();
  });

  it("strips a trailing slash from the base URL", async () => {
    process.env.PPF_SCANNER_URL = `${SCANNER_URL}/`;
    const { fetch, calls } = makeFetch(() => ({
      json: { address: "u1x000000000000000000", actualIndex: 0 },
    }));
    const client = createScannerClient(fetch);
    await client.deriveAddress({ ufvk: "uview1abc", diversifierIndex: 0 });
    expect(calls[0].url).toBe(`${SCANNER_URL}/derive`);
  });
});
