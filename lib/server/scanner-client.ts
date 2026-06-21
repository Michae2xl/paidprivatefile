// Typed client for the Rust scanner HTTP API (Marketplace Phase 1).
//
// The scanner is a SEPARATE service (built in /Users/maiconguimaraes/ppf-scanner)
// productionized from the spike at /Users/maiconguimaraes/ppf-ufvk-spike. This
// module never imports it; it only speaks HTTP. The contract lives in
// docs/marketplace-phase1-contract.md.
//
// Auth: every request carries `x-ppf-scanner-sig` = hex HMAC-SHA256(rawBody,
// PPF_SCANNER_SECRET). Responses are validated; failures surface as ServerError.
//
// The exported `ScannerClient` interface plus the injectable singleton lets the
// rest of the app depend on the abstraction and lets tests inject a fake.

import { createHmac } from "node:crypto";

import { ServerError } from "./error-kinds";

export type ScannerNetwork = "main" | "test" | "regtest";

export interface ScannerValidateInput {
  ufvk: string;
  ua?: string;
}

export interface ScannerValidateResult {
  valid: boolean;
  network: ScannerNetwork;
  fingerprint: string;
  defaultAddress: string;
  receivers: string[];
  uaMatches?: boolean;
}

export interface ScannerDeriveInput {
  ufvk: string;
  diversifierIndex: number;
}

export interface ScannerDeriveResult {
  address: string;
  actualIndex: number;
}

export interface ScannerClient {
  validateUfvk(input: ScannerValidateInput): Promise<ScannerValidateResult>;
  deriveAddress(input: ScannerDeriveInput): Promise<ScannerDeriveResult>;
}

// Narrow fetch type so tests can inject a fake without depending on lib.dom.
export type ScannerFetch = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<Response>;

const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/u;

export function createScannerClient(fetchImpl?: ScannerFetch): ScannerClient {
  const doFetch = fetchImpl ?? defaultFetch;

  return {
    async validateUfvk(input) {
      const body: ScannerValidateInput = { ufvk: input.ufvk };
      if (input.ua !== undefined) {
        body.ua = input.ua;
      }
      const parsed = await postJson(doFetch, "/validate", body);
      return parseValidateResult(parsed);
    },

    async deriveAddress(input) {
      const body: ScannerDeriveInput = {
        ufvk: input.ufvk,
        diversifierIndex: input.diversifierIndex,
      };
      const parsed = await postJson(doFetch, "/derive", body);
      return parseDeriveResult(parsed);
    },
  };
}

let activeClient: ScannerClient | null = null;

export function getScannerClient(): ScannerClient {
  if (!activeClient) {
    activeClient = createScannerClient();
  }
  return activeClient;
}

export function setScannerClientForTesting(client: ScannerClient | null): void {
  activeClient = client;
}

async function postJson(
  doFetch: ScannerFetch,
  path: string,
  body: unknown,
): Promise<unknown> {
  const url = `${scannerBaseUrl()}${path}`;
  const rawBody = JSON.stringify(body);
  const signature = createHmac("sha256", scannerSecret())
    .update(rawBody)
    .digest("hex");

  let response: Response;
  try {
    response = await doFetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-ppf-scanner-sig": signature,
      },
      body: rawBody,
    });
  } catch (error) {
    throw new ServerError(
      "cli_unavailable",
      `Scanner request failed: ${getErrorMessage(error)}`,
    );
  }

  if (!response.ok) {
    throw new ServerError(
      "cli_unavailable",
      `Scanner returned HTTP ${response.status}`,
    );
  }

  try {
    return (await response.json()) as unknown;
  } catch {
    throw new ServerError("cli_unavailable", "Scanner returned invalid JSON");
  }
}

function parseValidateResult(value: unknown): ScannerValidateResult {
  const record = asObject(value, "validate");
  const valid = record.valid;
  if (typeof valid !== "boolean") {
    throw scannerShapeError("validate.valid");
  }
  const network = parseNetwork(record.network);
  const fingerprint = record.fingerprint;
  if (
    typeof fingerprint !== "string" ||
    !FINGERPRINT_PATTERN.test(fingerprint)
  ) {
    throw scannerShapeError("validate.fingerprint");
  }
  const defaultAddress = record.defaultAddress;
  if (typeof defaultAddress !== "string" || !defaultAddress) {
    throw scannerShapeError("validate.defaultAddress");
  }
  const receivers = record.receivers;
  if (
    !Array.isArray(receivers) ||
    !receivers.every((entry) => typeof entry === "string")
  ) {
    throw scannerShapeError("validate.receivers");
  }
  const result: ScannerValidateResult = {
    valid,
    network,
    fingerprint,
    defaultAddress,
    receivers: receivers as string[],
  };
  if (record.uaMatches !== undefined) {
    if (typeof record.uaMatches !== "boolean") {
      throw scannerShapeError("validate.uaMatches");
    }
    result.uaMatches = record.uaMatches;
  }
  return result;
}

function parseDeriveResult(value: unknown): ScannerDeriveResult {
  const record = asObject(value, "derive");
  const address = record.address;
  if (typeof address !== "string" || !address) {
    throw scannerShapeError("derive.address");
  }
  const actualIndex = record.actualIndex;
  if (!Number.isSafeInteger(actualIndex) || (actualIndex as number) < 0) {
    throw scannerShapeError("derive.actualIndex");
  }
  return { address, actualIndex: actualIndex as number };
}

function parseNetwork(value: unknown): ScannerNetwork {
  if (value === "main" || value === "test" || value === "regtest") {
    return value;
  }
  throw scannerShapeError("validate.network");
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw scannerShapeError(label);
  }
  return value as Record<string, unknown>;
}

function scannerShapeError(field: string): ServerError {
  return new ServerError(
    "cli_unavailable",
    `Scanner response is missing or malformed field: ${field}`,
  );
}

function scannerBaseUrl(): string {
  const raw = process.env.PPF_SCANNER_URL?.trim();
  if (!raw) {
    throw new ServerError(
      "cli_unavailable",
      "Scanner is not configured (PPF_SCANNER_URL)",
    );
  }
  return raw.replace(/\/+$/u, "");
}

function scannerSecret(): string {
  const raw = process.env.PPF_SCANNER_SECRET?.trim();
  if (!raw) {
    throw new ServerError(
      "cli_unavailable",
      "Scanner is not configured (PPF_SCANNER_SECRET)",
    );
  }
  return raw;
}

const defaultFetch: ScannerFetch = (url, init) =>
  fetch(url, init as RequestInit);

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}
