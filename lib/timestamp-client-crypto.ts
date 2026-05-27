import {
  PALLAS_POSEIDON_MDS,
  PALLAS_POSEIDON_ROUND_CONSTANTS,
} from "./poseidon-pallas-constants";

export interface ClientTimestampReceipt {
  commitment_scheme: string;
  commitment: string;
  block_height: number;
  nonce: string;
  doc_hash_lo: string;
  doc_hash_hi: string;
  doc_hash_sha256: string;
  doc_hash_truncated?: string;
}

export interface ClientTimestampPublicReceipt {
  commitment_scheme?: string;
  commitment: string;
  block_height: number;
}

export interface ClientTimestampPrivateOpening {
  commitment_scheme?: string;
  nonce: string;
  doc_hash_lo: string;
  doc_hash_hi: string;
  doc_hash_sha256?: string;
  doc_hash_truncated?: string;
  document_size_bytes?: number;
}

export interface ClientTimestampDraft {
  receipt: ClientTimestampReceipt;
  documentSizeBytes: number;
}

export interface ClientTimestampDocumentHash {
  docHashLo: string;
  docHashHi: string;
  docHashSha256: string;
}

export interface ClientTimestampDocumentVerification
  extends ClientTimestampDocumentHash {
  commitment: string;
  openingMatchesFile: boolean;
  commitmentMatchesReceipt: boolean;
  matchesReceipt: boolean;
  uploadedSizeBytes: number;
}

const PALLAS_BASE_MODULUS = BigInt(
  "0x40000000000000000000000000000000224698fc094cf91b992d30ed00000001",
);
const POSEIDON_WIDTH = 3;
const POSEIDON_RATE = 2;
const POSEIDON_FULL_ROUNDS = 8;
const POSEIDON_PARTIAL_ROUNDS = 56;
const LEGACY_COMMITMENT_INPUTS = 3;
const COMMITMENT_INPUTS = 4;
const COMMITMENT_SCHEME = "zectime-poseidon-pallas-v2";
const LEGACY_COMMITMENT_SCHEME = "zectime-poseidon-pallas-v1";
const COMMITMENT_DOMAIN_TAG = 0x5a65_6354_696d_6532n;
const U64_HEX_LENGTH = 16;
const U128_HEX_LENGTH = 32;
const FIELD_HEX_LENGTH = 64;

const ROUND_CONSTANTS = PALLAS_POSEIDON_ROUND_CONSTANTS.map((row) =>
  row.map((value) => BigInt(value)),
);
const MDS = PALLAS_POSEIDON_MDS.map((row) =>
  row.map((value) => BigInt(value)),
);

export async function createClientTimestampDraft(
  file: File,
): Promise<ClientTimestampDraft> {
  const hash = await hashClientTimestampDocument(file);
  const docHashLo = parseU128Hex(hash.docHashLo);
  const docHashHi = parseU128Hex(hash.docHashHi);
  const nonce = randomU128();
  const commitment = poseidonPallasCommitment(docHashLo, docHashHi, nonce);

  return {
    documentSizeBytes: file.size,
    receipt: {
      commitment_scheme: COMMITMENT_SCHEME,
      commitment,
      block_height: 0,
      nonce: formatU128Hex(nonce),
      doc_hash_lo: hash.docHashLo,
      doc_hash_hi: hash.docHashHi,
      doc_hash_sha256: hash.docHashSha256,
    },
  };
}

export async function hashClientTimestampDocument(
  file: File,
): Promise<ClientTimestampDocumentHash> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return {
    docHashLo: formatU128Hex(littleEndianBytesToBigInt(digest.slice(0, 16))),
    docHashHi: formatU128Hex(littleEndianBytesToBigInt(digest.slice(16, 32))),
    docHashSha256: bytesToHex(digest),
  };
}

export function buildClientTimestampPublicReceipt(
  receipt: ClientTimestampReceipt,
): ClientTimestampPublicReceipt {
  return {
    commitment_scheme: receipt.commitment_scheme,
    commitment: normalizeFieldHex(receipt.commitment),
    block_height: receipt.block_height,
  };
}

export function buildClientTimestampPrivateOpening(
  receipt: ClientTimestampReceipt,
  documentSizeBytes?: number,
): ClientTimestampPrivateOpening {
  return {
    commitment_scheme: receipt.commitment_scheme,
    nonce: normalizeU128Hex(receipt.nonce),
    doc_hash_lo: normalizeU128Hex(receipt.doc_hash_lo),
    doc_hash_hi: normalizeU128Hex(receipt.doc_hash_hi),
    doc_hash_sha256: normalizeSha256Hex(receipt.doc_hash_sha256),
    ...(typeof documentSizeBytes === "number"
      ? { document_size_bytes: documentSizeBytes }
      : {}),
  };
}

export function commitmentFromClientTimestampOpening(
  opening: ClientTimestampPrivateOpening,
): string {
  if (isLegacyOpening(opening)) {
    return poseidonPallasCommitmentV1(
      parseU64Hex(opening.doc_hash_lo),
      parseU64Hex(opening.doc_hash_hi),
      parseU64Hex(opening.nonce),
    );
  }

  return poseidonPallasCommitment(
    parseU128Hex(opening.doc_hash_lo),
    parseU128Hex(opening.doc_hash_hi),
    parseU128Hex(opening.nonce),
  );
}

export async function verifyClientTimestampDocument(
  file: File,
  publicReceipt: ClientTimestampPublicReceipt,
  opening: ClientTimestampPrivateOpening,
): Promise<ClientTimestampDocumentVerification> {
  const hash = await hashClientTimestampDocument(file);
  const normalizedOpening = normalizePrivateOpening(opening);
  const commitment = commitmentFromClientTimestampOpening(normalizedOpening);
  const openingMatchesFile = isLegacyOpening(normalizedOpening)
    ? hash.docHashLo.slice(16) === normalizedOpening.doc_hash_lo &&
      hash.docHashLo.slice(0, 16) === normalizedOpening.doc_hash_hi &&
      hash.docHashSha256.slice(0, 32) === normalizedOpening.doc_hash_truncated
    : hash.docHashLo === normalizedOpening.doc_hash_lo &&
      hash.docHashHi === normalizedOpening.doc_hash_hi &&
      hash.docHashSha256 === normalizedOpening.doc_hash_sha256;
  const commitmentMatchesReceipt =
    commitment === normalizeFieldHex(publicReceipt.commitment);

  return {
    ...hash,
    commitment,
    openingMatchesFile,
    commitmentMatchesReceipt,
    matchesReceipt: openingMatchesFile && commitmentMatchesReceipt,
    uploadedSizeBytes: file.size,
  };
}

export function poseidonPallasCommitment(
  docHashLo: bigint,
  docHashHi: bigint,
  nonce: bigint,
): string {
  return poseidonPallasHash(COMMITMENT_INPUTS, [
    COMMITMENT_DOMAIN_TAG,
    docHashLo,
    docHashHi,
    nonce,
  ]);
}

export function poseidonPallasCommitmentV1(
  docHashLo: bigint,
  docHashHi: bigint,
  nonce: bigint,
): string {
  return poseidonPallasHash(LEGACY_COMMITMENT_INPUTS, [
    docHashLo,
    docHashHi,
    nonce,
  ]);
}

function poseidonPallasHash(inputCount: number, inputs: readonly bigint[]): string {
  const capacity = BigInt(inputCount) << 64n;
  const state: [bigint, bigint, bigint] = [0n, 0n, capacity];
  for (let index = 0; index < inputs.length; index += POSEIDON_RATE) {
    absorbAndPermute(state, [
      inputs[index] ?? 0n,
      inputs[index + 1] ?? 0n,
    ]);
  }
  return formatFieldHex(state[0]);
}

function absorbAndPermute(
  state: [bigint, bigint, bigint],
  values: [bigint, bigint],
) {
  for (let index = 0; index < POSEIDON_RATE; index += 1) {
    state[index] = fieldAdd(state[index], values[index]);
  }
  poseidonPermute(state);
}

function poseidonPermute(state: [bigint, bigint, bigint]) {
  const halfFullRounds = POSEIDON_FULL_ROUNDS / 2;
  let round = 0;

  for (; round < halfFullRounds; round += 1) {
    fullRound(state, ROUND_CONSTANTS[round]);
  }
  for (; round < halfFullRounds + POSEIDON_PARTIAL_ROUNDS; round += 1) {
    partialRound(state, ROUND_CONSTANTS[round]);
  }
  for (; round < POSEIDON_FULL_ROUNDS + POSEIDON_PARTIAL_ROUNDS; round += 1) {
    fullRound(state, ROUND_CONSTANTS[round]);
  }
}

function fullRound(state: [bigint, bigint, bigint], constants: readonly bigint[]) {
  for (let index = 0; index < POSEIDON_WIDTH; index += 1) {
    state[index] = fieldPow5(fieldAdd(state[index], constants[index]));
  }
  applyMds(state);
}

function partialRound(
  state: [bigint, bigint, bigint],
  constants: readonly bigint[],
) {
  for (let index = 0; index < POSEIDON_WIDTH; index += 1) {
    state[index] = fieldAdd(state[index], constants[index]);
  }
  state[0] = fieldPow5(state[0]);
  applyMds(state);
}

function applyMds(state: [bigint, bigint, bigint]) {
  const next: [bigint, bigint, bigint] = [0n, 0n, 0n];
  for (let row = 0; row < POSEIDON_WIDTH; row += 1) {
    for (let col = 0; col < POSEIDON_WIDTH; col += 1) {
      next[row] = fieldAdd(next[row], fieldMul(MDS[row][col], state[col]));
    }
  }
  state[0] = next[0];
  state[1] = next[1];
  state[2] = next[2];
}

function fieldAdd(left: bigint, right: bigint): bigint {
  return (left + right) % PALLAS_BASE_MODULUS;
}

function fieldMul(left: bigint, right: bigint): bigint {
  return (left * right) % PALLAS_BASE_MODULUS;
}

function fieldPow5(value: bigint): bigint {
  const squared = fieldMul(value, value);
  const fourth = fieldMul(squared, squared);
  return fieldMul(fourth, value);
}

function randomU128(): bigint {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return littleEndianBytesToBigInt(bytes);
}

function littleEndianBytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (let index = bytes.length - 1; index >= 0; index -= 1) {
    value = (value << 8n) + BigInt(bytes[index]);
  }
  return value;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function formatU64Hex(value: bigint): string {
  return value.toString(16).padStart(U64_HEX_LENGTH, "0");
}

function formatU128Hex(value: bigint): string {
  return value.toString(16).padStart(U128_HEX_LENGTH, "0");
}

function formatFieldHex(value: bigint): string {
  const bytes = new Uint8Array(FIELD_HEX_LENGTH / 2);
  let remaining = value;
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return bytesToHex(bytes);
}

function parseU64Hex(value: string): bigint {
  return BigInt(`0x${normalizeU64Hex(value)}`);
}

function parseU128Hex(value: string): bigint {
  return BigInt(`0x${normalizeU128Hex(value)}`);
}

function normalizeU64Hex(value: string): string {
  const normalized = value.trim().replace(/^0x/iu, "").toLowerCase();
  if (!/^[0-9a-f]{16}$/u.test(normalized)) {
    throw new Error("Expected 8-byte hex value");
  }
  return normalized;
}

function normalizeU128Hex(value: string): string {
  const normalized = value.trim().replace(/^0x/iu, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/u.test(normalized)) {
    throw new Error("Expected 16-byte hex value");
  }
  return normalized;
}

function normalizeFieldHex(value: string): string {
  const normalized = value.trim().replace(/^0x/iu, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/u.test(normalized)) {
    throw new Error("Expected 32-byte hex value");
  }
  return normalized;
}

function normalizeTruncatedHashHex(value: string): string {
  const normalized = value.trim().replace(/^0x/iu, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/u.test(normalized)) {
    throw new Error("Expected 16-byte hex value");
  }
  return normalized;
}

function normalizeSha256Hex(value: string): string {
  const normalized = value.trim().replace(/^0x/iu, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/u.test(normalized)) {
    throw new Error("Expected 32-byte SHA-256 hex value");
  }
  return normalized;
}

function isLegacyOpening(opening: ClientTimestampPrivateOpening): boolean {
  return (
    opening.commitment_scheme === LEGACY_COMMITMENT_SCHEME ||
    (!opening.commitment_scheme && typeof opening.doc_hash_truncated === "string")
  );
}

function normalizePrivateOpening(
  opening: ClientTimestampPrivateOpening,
): ClientTimestampPrivateOpening {
  if (isLegacyOpening(opening)) {
    return {
      commitment_scheme: LEGACY_COMMITMENT_SCHEME,
      nonce: normalizeU64Hex(opening.nonce),
      doc_hash_lo: normalizeU64Hex(opening.doc_hash_lo),
      doc_hash_hi: normalizeU64Hex(opening.doc_hash_hi),
      doc_hash_truncated: normalizeTruncatedHashHex(
        opening.doc_hash_truncated ?? "",
      ),
      ...(typeof opening.document_size_bytes === "number"
        ? { document_size_bytes: opening.document_size_bytes }
        : {}),
    };
  }

  return {
    commitment_scheme: COMMITMENT_SCHEME,
    nonce: normalizeU128Hex(opening.nonce),
    doc_hash_lo: normalizeU128Hex(opening.doc_hash_lo),
    doc_hash_hi: normalizeU128Hex(opening.doc_hash_hi),
    doc_hash_sha256: normalizeSha256Hex(opening.doc_hash_sha256 ?? ""),
    ...(typeof opening.document_size_bytes === "number"
      ? { document_size_bytes: opening.document_size_bytes }
      : {}),
  };
}
