// Clean-room browser-to-browser chunked file transfer over the Nym mixnet.
//
// This module is framework-agnostic (no React, no DOM, no SDK import). It splits
// a ciphertext blob into rate-paced chunks, ships them to a recipient over a
// caller-supplied raw-send function, and reassembles them order-independently on
// the receiver with a stop-and-report ARQ (automatic repeat request): the
// receiver asks for any chunk it is missing, the sender re-streams it plus a
// small forward window. Integrity is pinned by a SHA-256 over the whole
// ciphertext, sent in the Offer and re-verified after reassembly.
//
// Framing, sequencing, and the ARQ here are an independent implementation of the
// standard chunk+counter+retransmit pattern. No third-party transfer code was
// copied. We deliberately do NOT do key agreement here (the buyer is already
// authenticated by the existing P-256 ECDH key envelope and the ciphertext is
// already AES-256-GCM encrypted), so this is a pure reliable-bytes layer.

// ---------------------------------------------------------------------------
// Wire format
// ---------------------------------------------------------------------------
//
// Every packet is a single Uint8Array with a fixed-size header followed by an
// optional payload. All multi-byte integers are big-endian.
//
//   byte  0      : MAGIC[0]            (0x4e == 'N')
//   byte  1      : MAGIC[1]            (0x46 == 'F')
//   byte  2      : VERSION             (0x01)
//   byte  3      : TYPE                (see PacketType)
//   bytes 4..35  : orderId            (32 bytes, ASCII, right-padded with 0x00)
//   bytes 36..39 : seq                (uint32 — chunk index, or requested seq)
//   bytes 40..43 : total              (uint32 — total chunk count)
//   bytes 44..47 : payloadLength      (uint32 — bytes of payload that follow)
//   bytes 48..   : payload            (payloadLength bytes)
//
// Header is HEADER_BYTES (48) long. Payload meaning by type:
//   OFFER       : JSON { size, sha256, chunkSize } describing the transfer.
//   CHUNK       : the raw ciphertext bytes for chunk `seq`.
//   ACK         : empty (sent by receiver once the full file is verified).
//   RETRANSMIT  : empty (the missing chunk index is carried in `seq`).
//   DONE        : JSON { sha256 } — sender's end-of-stream marker.

const MAGIC_0 = 0x4e; // 'N'
const MAGIC_1 = 0x46; // 'F'
const VERSION = 0x01;

const HEADER_BYTES = 48;
const ORDER_ID_OFFSET = 4;
const ORDER_ID_BYTES = 32;
const SEQ_OFFSET = 36;
const TOTAL_OFFSET = 40;
const PAYLOAD_LEN_OFFSET = 44;

export enum PacketType {
  Offer = 0x01,
  Chunk = 0x02,
  Ack = 0x03,
  Retransmit = 0x04,
  Done = 0x05,
}

export interface NymTransferPacket {
  type: PacketType;
  orderId: string;
  seq: number;
  total: number;
  payload: Uint8Array;
}

export interface NymTransferOffer {
  size: number;
  sha256: string;
  chunkSize: number;
  // The sender's own Nym address, so the receiver knows where to send its
  // Retransmit/Ack control frames (Nym rawSend requires an explicit recipient).
  senderAddress?: string;
}

// 32 KiB application chunk size. The full packet adds a 48-byte header, which
// stays comfortably inside a single Nym message.
export const DEFAULT_CHUNK_SIZE = 32 * 1024;

// Rate pacing. The Nym gateway drains roughly 46 KiB/s; sending faster than it
// can drain stalls the local outbox. We target ~48 KiB/s by sleeping between
// chunks so the effective rate (chunk bytes / inter-chunk delay) stays at or
// below the drain rate. REQUIRED — unpaced sends were observed to hang.
export const DEFAULT_RATE_BYTES_PER_SEC = 48 * 1024;

// How long the receiver waits without progress before asking for the first
// missing chunk, and how often it re-asks afterwards.
export const DEFAULT_GAP_TIMEOUT_MS = 30_000;

// When the sender handles a Retransmit{seq}, it resends `seq` plus this many
// following chunks (a small forward window), which repairs a short run of drops
// in one round-trip instead of one chunk per round-trip.
export const DEFAULT_RETRANSMIT_WINDOW = 4;

// ---------------------------------------------------------------------------
// Encoding / decoding
// ---------------------------------------------------------------------------

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function writeOrderId(view: Uint8Array, orderId: string): void {
  const encoded = textEncoder.encode(orderId);
  if (encoded.length > ORDER_ID_BYTES) {
    throw new Error(
      `orderId too long for frame (${encoded.length} > ${ORDER_ID_BYTES} bytes)`,
    );
  }
  view.set(encoded, ORDER_ID_OFFSET);
  // Remaining bytes are already 0x00 from the zero-filled buffer.
}

function readOrderId(view: Uint8Array): string {
  const slice = view.subarray(
    ORDER_ID_OFFSET,
    ORDER_ID_OFFSET + ORDER_ID_BYTES,
  );
  let end = slice.length;
  while (end > 0 && slice[end - 1] === 0x00) {
    end -= 1;
  }
  return textDecoder.decode(slice.subarray(0, end));
}

function writeUint32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value >>> 0, false);
}

export function encodePacket(packet: NymTransferPacket): Uint8Array {
  const payload = packet.payload ?? new Uint8Array(0);
  const buffer = new Uint8Array(HEADER_BYTES + payload.length);
  buffer[0] = MAGIC_0;
  buffer[1] = MAGIC_1;
  buffer[2] = VERSION;
  buffer[3] = packet.type;
  writeOrderId(buffer, packet.orderId);
  const view = new DataView(buffer.buffer);
  writeUint32(view, SEQ_OFFSET, packet.seq);
  writeUint32(view, TOTAL_OFFSET, packet.total);
  writeUint32(view, PAYLOAD_LEN_OFFSET, payload.length);
  buffer.set(payload, HEADER_BYTES);
  return buffer;
}

// Decode a packet. Returns null for anything that is not a well-formed transfer
// frame (foreign messages on the same Nym client, truncated bytes, etc.), so a
// caller can safely feed it every inbound raw message.
export function decodePacket(bytes: Uint8Array): NymTransferPacket | null {
  if (bytes.length < HEADER_BYTES) {
    return null;
  }
  if (bytes[0] !== MAGIC_0 || bytes[1] !== MAGIC_1 || bytes[2] !== VERSION) {
    return null;
  }
  const type = bytes[3];
  if (
    type !== PacketType.Offer &&
    type !== PacketType.Chunk &&
    type !== PacketType.Ack &&
    type !== PacketType.Retransmit &&
    type !== PacketType.Done
  ) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const seq = view.getUint32(SEQ_OFFSET, false);
  const total = view.getUint32(TOTAL_OFFSET, false);
  const payloadLength = view.getUint32(PAYLOAD_LEN_OFFSET, false);
  if (HEADER_BYTES + payloadLength > bytes.length) {
    return null;
  }
  const payload = bytes.subarray(HEADER_BYTES, HEADER_BYTES + payloadLength);
  return {
    type: type as PacketType,
    orderId: readOrderId(bytes),
    seq,
    total,
    // Copy out so the returned payload is independent of the source buffer.
    payload: payload.slice(),
  };
}

function encodeJsonPayload(value: unknown): Uint8Array {
  return textEncoder.encode(JSON.stringify(value));
}

function decodeJsonPayload<T>(payload: Uint8Array): T | null {
  try {
    return JSON.parse(textDecoder.decode(payload)) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Integrity
// ---------------------------------------------------------------------------

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

// SHA-256 over the whole ciphertext, returned as lowercase hex. Uses WebCrypto
// (available in the browser and in Node's test runtime via globalThis.crypto).
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const ab = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", ab);
  return bytesToHex(new Uint8Array(digest));
}

// ---------------------------------------------------------------------------
// Chunking helpers (pure — unit-tested directly)
// ---------------------------------------------------------------------------

export function chunkBytes(
  bytes: Uint8Array,
  chunkSize: number = DEFAULT_CHUNK_SIZE,
): Uint8Array[] {
  if (chunkSize <= 0) {
    throw new Error("chunkSize must be positive");
  }
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(
      bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)),
    );
  }
  // A zero-length input is still one transfer of zero chunks; callers treat
  // total === 0 as "nothing to send" but the framing supports it.
  return chunks;
}

export function reassembleChunks(
  chunks: Map<number, Uint8Array>,
  total: number,
): Uint8Array {
  let size = 0;
  for (let seq = 0; seq < total; seq += 1) {
    const chunk = chunks.get(seq);
    if (!chunk) {
      throw new Error(`cannot reassemble: missing chunk ${seq}/${total}`);
    }
    size += chunk.length;
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (let seq = 0; seq < total; seq += 1) {
    const chunk = chunks.get(seq)!;
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sender
// ---------------------------------------------------------------------------

export type RawSendFn = (payload: Uint8Array) => Promise<void>;

export interface NymFileSenderOptions {
  chunkSize?: number;
  rateBytesPerSec?: number;
  retransmitWindow?: number;
  // The sender's own Nym address, advertised in the Offer/Done so the receiver
  // can address its Retransmit/Ack control frames back to this sender.
  senderAddress?: string;
  // Resolve only after the receiver acknowledges. The local Nym client may still
  // be draining buffered packets after the last send resolves, so the sender
  // must not consider the transfer complete until an Ack lands.
  ackTimeoutMs?: number;
  onProgress?: (sent: number, total: number) => void;
  // Injectable sleep so tests run without real timers.
  sleep?: (ms: number) => Promise<void>;
  // Injectable abort signal: when this returns true the sender stops early
  // (used to wire React unmount / fallback into the loop).
  shouldAbort?: () => boolean;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A live sender that has emitted the Offer and is streaming chunks. The caller
// must route inbound Retransmit/Ack packets into handlePacket() so the ARQ and
// completion latch work. done() resolves once the Ack arrives (or rejects on
// timeout/abort).
export interface NymFileSender {
  // Feed an inbound transfer packet (Retransmit / Ack) addressed to this order.
  handlePacket(packet: NymTransferPacket): void;
  // Resolves when the receiver acks; rejects on timeout or abort.
  done(): Promise<void>;
}

export async function startNymFileSender(
  orderId: string,
  ciphertext: Uint8Array,
  rawSend: RawSendFn,
  options: NymFileSenderOptions = {},
): Promise<NymFileSender> {
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const rate = options.rateBytesPerSec ?? DEFAULT_RATE_BYTES_PER_SEC;
  const window = options.retransmitWindow ?? DEFAULT_RETRANSMIT_WINDOW;
  const ackTimeoutMs = options.ackTimeoutMs ?? 120_000;
  const sleep = options.sleep ?? defaultSleep;

  const chunks = chunkBytes(ciphertext, chunkSize);
  const total = chunks.length;
  const sha256 = await sha256Hex(ciphertext);

  // Inter-chunk delay (ms) to hold the average rate at/below `rate`.
  const interChunkDelayMs = rate > 0 ? Math.ceil((chunkSize / rate) * 1000) : 0;

  let acked = false;
  // Single-flight state for the Retransmit handler (see handlePacket).
  let retransmitting = false;
  let pendingRetransmitSeq: number | null = null;
  let resolveDone: (() => void) | null = null;
  let rejectDone: ((error: Error) => void) | null = null;
  const donePromise = new Promise<void>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  async function sendChunk(seq: number): Promise<void> {
    if (seq < 0 || seq >= total) {
      return;
    }
    await rawSend(
      encodePacket({
        type: PacketType.Chunk,
        orderId,
        seq,
        total,
        payload: chunks[seq],
      }),
    );
  }

  async function sendDone(): Promise<void> {
    await rawSend(
      encodePacket({
        type: PacketType.Done,
        orderId,
        seq: 0,
        total,
        payload: encodeJsonPayload({
          sha256,
          senderAddress: options.senderAddress,
        }),
      }),
    );
  }

  function handlePacket(packet: NymTransferPacket): void {
    if (packet.orderId !== orderId) {
      return;
    }
    if (packet.type === PacketType.Ack) {
      acked = true;
      resolveDone?.();
      return;
    }
    if (packet.type === PacketType.Retransmit) {
      // Single-flight: a Retransmit that arrives while one is being serviced is
      // coalesced (we just record the newest requested seq) rather than spawning
      // a second overlapping coroutine. Overlapping coroutines would stack the
      // pacing delays and self-amplify traffic in exactly the lossy conditions
      // where ARQ matters. The pending seq is serviced right after the current
      // window finishes.
      pendingRetransmitSeq = packet.seq;
      if (retransmitting) {
        return;
      }
      retransmitting = true;
      void (async () => {
        try {
          while (pendingRetransmitSeq !== null && !acked) {
            const startSeq = pendingRetransmitSeq;
            pendingRetransmitSeq = null;
            for (let i = 0; i < window; i += 1) {
              const seq = startSeq + i;
              if (seq >= total) {
                break;
              }
              try {
                await sendChunk(seq);
              } catch {
                return;
              }
              if (interChunkDelayMs > 0) {
                await sleep(interChunkDelayMs);
              }
            }
            try {
              await sendDone();
            } catch {
              // The receiver re-asks on the next gap timeout.
            }
          }
        } finally {
          retransmitting = false;
        }
      })();
    }
  }

  // Stream the offer + all chunks + done in the background. The returned sender
  // is usable for handlePacket as soon as the offer is out.
  async function streamAll(): Promise<void> {
    await rawSend(
      encodePacket({
        type: PacketType.Offer,
        orderId,
        seq: 0,
        total,
        payload: encodeJsonPayload({
          size: ciphertext.length,
          sha256,
          chunkSize,
          senderAddress: options.senderAddress,
        } satisfies NymTransferOffer),
      }),
    );

    options.onProgress?.(0, total);
    for (let seq = 0; seq < total; seq += 1) {
      if (acked || options.shouldAbort?.()) {
        break;
      }
      await sendChunk(seq);
      options.onProgress?.(seq + 1, total);
      if (interChunkDelayMs > 0 && seq < total - 1) {
        await sleep(interChunkDelayMs);
      }
    }

    if (!acked) {
      await sendDone();
    }
  }

  // Kick off streaming, but also arm an ack timeout. We surface streaming
  // errors through the done promise.
  void streamAll().catch((error: unknown) => {
    rejectDone?.(error instanceof Error ? error : new Error(String(error)));
  });

  const timeout = setTimeout(() => {
    if (!acked) {
      rejectDone?.(new Error("nym file transfer: ack timed out"));
    }
  }, ackTimeoutMs);
  // Make sure the timer never keeps a Node test process alive.
  if (typeof (timeout as { unref?: () => void }).unref === "function") {
    (timeout as { unref?: () => void }).unref?.();
  }

  return {
    handlePacket,
    done: () =>
      donePromise.finally(() => {
        clearTimeout(timeout);
      }),
  };
}

// ---------------------------------------------------------------------------
// Receiver
// ---------------------------------------------------------------------------

export interface NymFileReceiverOptions {
  // The expected SHA-256 of the ciphertext (from the order). The receiver
  // verifies the reassembled bytes against BOTH this and the Offer's hash.
  expectedSha256?: string;
  gapTimeoutMs?: number;
  // Overall ceiling: if the file never completes within this window the
  // receiver rejects, so the caller can fall back to HTTPS.
  overallTimeoutMs?: number;
  onProgress?: (received: number, total: number) => void;
  // Injectable timers for tests.
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface NymFileReceiver {
  // Feed an inbound transfer packet. Foreign / non-matching packets are ignored.
  handlePacket(packet: NymTransferPacket): void;
  // Resolves with the verified, reassembled ciphertext; rejects on timeout or
  // an integrity mismatch.
  done(): Promise<Uint8Array>;
  // Stop timers and reject the pending promise (used on unmount / fallback).
  abort(reason?: string): void;
}

// The receiver addresses its control frames (Retransmit/Ack) to the sender's
// Nym address, which it learns from the Offer/Done. `sendControl` takes both the
// bytes and that recipient so the host can call the SDK's rawSend({ payload,
// recipient }). Frames before the sender address is known are skipped (the gap
// timer re-asks once the Offer lands).
export type ReceiverControlSendFn = (
  payload: Uint8Array,
  recipient: string,
) => Promise<void>;

// A receiver routes inbound packets via handlePacket and emits Retransmit/Ack
// packets through `sendControl`. It decodes order-independently, asks for gaps
// after silence, verifies on Done, and resolves the reassembled ciphertext.
export function createNymFileReceiver(
  orderId: string,
  sendControl: ReceiverControlSendFn,
  options: NymFileReceiverOptions = {},
): NymFileReceiver {
  const gapTimeoutMs = options.gapTimeoutMs ?? DEFAULT_GAP_TIMEOUT_MS;
  const overallTimeoutMs = options.overallTimeoutMs ?? 600_000;
  const setTimer =
    options.setTimer ?? ((fn, ms) => setTimeout(fn, ms) as unknown);
  const clearTimer =
    options.clearTimer ?? ((handle) => clearTimeout(handle as never));

  const chunks = new Map<number, Uint8Array>();
  let total = 0;
  let offerSha256: string | null = null;
  let senderAddress: string | null = null;
  let settled = false;
  let gapTimer: unknown = null;
  let overallTimer: unknown = null;

  let resolveDone: ((bytes: Uint8Array) => void) | null = null;
  let rejectDone: ((error: Error) => void) | null = null;
  const donePromise = new Promise<Uint8Array>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  function cleanup(): void {
    if (gapTimer !== null) {
      clearTimer(gapTimer);
      gapTimer = null;
    }
    if (overallTimer !== null) {
      clearTimer(overallTimer);
      overallTimer = null;
    }
  }

  function settle(error: Error | null, bytes?: Uint8Array): void {
    if (settled) {
      return;
    }
    settled = true;
    cleanup();
    if (error) {
      rejectDone?.(error);
    } else if (bytes) {
      resolveDone?.(bytes);
    }
  }

  function firstMissingSeq(): number {
    if (total === 0) {
      return -1;
    }
    for (let seq = 0; seq < total; seq += 1) {
      if (!chunks.has(seq)) {
        return seq;
      }
    }
    return -1;
  }

  function requestFirstGap(): void {
    const missing = firstMissingSeq();
    if (missing < 0 || !senderAddress) {
      // Without the sender address (Offer not yet seen) we cannot address a
      // control frame; the gap timer re-asks once the Offer lands.
      return;
    }
    void sendControl(
      encodePacket({
        type: PacketType.Retransmit,
        orderId,
        seq: missing,
        total,
        payload: new Uint8Array(0),
      }),
      senderAddress,
    ).catch(() => {
      // The next gap tick re-asks.
    });
  }

  // (Re)arm the silence timer. Called whenever a chunk lands so steady progress
  // never triggers a retransmit; only a genuine stall does.
  function armGapTimer(): void {
    if (settled) {
      return;
    }
    if (gapTimer !== null) {
      clearTimer(gapTimer);
    }
    gapTimer = setTimer(() => {
      if (settled) {
        return;
      }
      requestFirstGap();
      armGapTimer();
    }, gapTimeoutMs);
  }

  async function finalizeIfComplete(): Promise<void> {
    if (settled || total === 0) {
      return;
    }
    if (chunks.size < total || firstMissingSeq() >= 0) {
      return;
    }
    let reassembled: Uint8Array;
    try {
      reassembled = reassembleChunks(chunks, total);
    } catch (error) {
      settle(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    const actual = await sha256Hex(reassembled);
    const expected = options.expectedSha256 ?? offerSha256;
    if (expected && actual !== expected) {
      settle(
        new Error(
          `nym file transfer: sha-256 mismatch (expected ${expected}, got ${actual})`,
        ),
      );
      return;
    }
    if (offerSha256 && actual !== offerSha256) {
      settle(new Error("nym file transfer: reassembled hash != offer hash"));
      return;
    }
    // Acknowledge so the sender's loop can stop (best-effort — a missing sender
    // address or a dropped ack is covered by the sender's overall ack-timeout).
    if (senderAddress) {
      void sendControl(
        encodePacket({
          type: PacketType.Ack,
          orderId,
          seq: total,
          total,
          payload: new Uint8Array(0),
        }),
        senderAddress,
      ).catch(() => {
        // The sender's overall ack-timeout covers a dropped ack; either way the
        // receiver already has the verified file.
      });
    }
    settle(null, reassembled);
  }

  function handlePacket(packet: NymTransferPacket): void {
    if (settled || packet.orderId !== orderId) {
      return;
    }
    if (packet.type === PacketType.Offer) {
      const offer = decodeJsonPayload<NymTransferOffer>(packet.payload);
      total = packet.total;
      offerSha256 = offer?.sha256 ?? offerSha256;
      senderAddress = offer?.senderAddress ?? senderAddress;
      options.onProgress?.(chunks.size, total);
      armGapTimer();
      return;
    }
    if (packet.type === PacketType.Chunk) {
      if (total === 0 && packet.total > 0) {
        total = packet.total;
      }
      if (!chunks.has(packet.seq)) {
        chunks.set(packet.seq, packet.payload);
        options.onProgress?.(chunks.size, total);
      }
      armGapTimer();
      void finalizeIfComplete();
      return;
    }
    if (packet.type === PacketType.Done) {
      if (total === 0 && packet.total > 0) {
        total = packet.total;
      }
      const offer = decodeJsonPayload<{
        sha256: string;
        senderAddress?: string;
      }>(packet.payload);
      offerSha256 = offer?.sha256 ?? offerSha256;
      senderAddress = offer?.senderAddress ?? senderAddress;
      // On Done, immediately ask for any gap rather than waiting for silence,
      // then try to finalize.
      if (firstMissingSeq() >= 0) {
        requestFirstGap();
        armGapTimer();
      } else {
        void finalizeIfComplete();
      }
      return;
    }
    // Ack / Retransmit are sender-side concerns; ignore on the receiver.
  }

  function abort(reason?: string): void {
    settle(new Error(reason ?? "nym file transfer: receiver aborted"));
  }

  overallTimer = setTimer(() => {
    settle(new Error("nym file transfer: receive timed out"));
  }, overallTimeoutMs);

  return {
    handlePacket,
    done: () => donePromise,
    abort,
  };
}
