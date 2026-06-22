// Unit tests for the clean-room Nym chunked file transfer.
//
// These exercise the pure pieces (framing, chunking, reassembly) and the full
// sender<->receiver handshake over an in-memory transport double, including a
// simulated-loss path that proves the ARQ (Retransmit) repairs dropped chunks.
// No real Nym SDK, no DOM, no React.

import { describe, expect, it, vi } from "vitest";

import {
  PacketType,
  chunkBytes,
  createNymFileReceiver,
  decodePacket,
  encodePacket,
  reassembleChunks,
  sha256Hex,
  startNymFileSender,
  type NymTransferPacket,
} from "../lib/nym-file-transfer";

function makeBytes(length: number, seed = 1): Uint8Array {
  const out = new Uint8Array(length);
  let x = seed >>> 0;
  for (let i = 0; i < length; i += 1) {
    // Cheap deterministic PRNG so the SHA-256 round-trip is meaningful.
    x = (x * 1664525 + 1013904223) >>> 0;
    out[i] = x & 0xff;
  }
  return out;
}

// No-op pacing so the sender does not sleep in tests.
const noSleep = async (): Promise<void> => undefined;

describe("framing", () => {
  it("round-trips a chunk packet through encode/decode", () => {
    const payload = makeBytes(100, 7);
    const packet: NymTransferPacket = {
      type: PacketType.Chunk,
      orderId: "order_abc123",
      seq: 42,
      total: 1000,
      payload,
    };
    const decoded = decodePacket(encodePacket(packet));
    expect(decoded).not.toBeNull();
    expect(decoded!.type).toBe(PacketType.Chunk);
    expect(decoded!.orderId).toBe("order_abc123");
    expect(decoded!.seq).toBe(42);
    expect(decoded!.total).toBe(1000);
    expect(Array.from(decoded!.payload)).toEqual(Array.from(payload));
  });

  it("returns null for non-transfer bytes (foreign messages)", () => {
    expect(decodePacket(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(decodePacket(new TextEncoder().encode("hello world"))).toBeNull();
  });

  it("returns null for a truncated payload", () => {
    const full = encodePacket({
      type: PacketType.Chunk,
      orderId: "x",
      seq: 0,
      total: 1,
      payload: makeBytes(64),
    });
    expect(decodePacket(full.subarray(0, full.length - 10))).toBeNull();
  });

  it("rejects an orderId that does not fit the frame", () => {
    expect(() =>
      encodePacket({
        type: PacketType.Offer,
        orderId: "x".repeat(64),
        seq: 0,
        total: 0,
        payload: new Uint8Array(0),
      }),
    ).toThrow();
  });
});

describe("chunkBytes / reassembleChunks", () => {
  it("splits into chunkSize pieces and reassembles to the original", () => {
    const bytes = makeBytes(32 * 1024 * 3 + 123, 99);
    const chunkSize = 32 * 1024;
    const chunks = chunkBytes(bytes, chunkSize);
    expect(chunks.length).toBe(4); // 3 full + 1 partial
    expect(chunks[0].length).toBe(chunkSize);
    expect(chunks[3].length).toBe(123);

    const map = new Map<number, Uint8Array>();
    chunks.forEach((chunk, seq) => map.set(seq, chunk));
    const out = reassembleChunks(map, chunks.length);
    expect(Array.from(out)).toEqual(Array.from(bytes));
  });

  it("throws when a chunk is missing", () => {
    const map = new Map<number, Uint8Array>([[0, makeBytes(10)]]);
    expect(() => reassembleChunks(map, 3)).toThrow(/missing chunk/);
  });
});

// In-memory transport double: each side gets a sink. We wire the receiver's
// control sink into the sender's handlePacket and the sender's data sink into
// the receiver's handlePacket. A loss predicate can drop sender->receiver
// chunks to simulate mixnet drops.
function wireTransport(opts: {
  shouldDropSenderPacket?: (packet: NymTransferPacket) => boolean;
}) {
  let senderRef: { handlePacket(p: NymTransferPacket): void } | null = null;
  let receiverRef: { handlePacket(p: NymTransferPacket): void } | null = null;

  const senderRawSend = async (payload: Uint8Array): Promise<void> => {
    const packet = decodePacket(payload);
    if (!packet) return;
    if (opts.shouldDropSenderPacket?.(packet)) {
      return; // dropped in flight
    }
    // Deliver asynchronously so the sender's await resolves before the receiver
    // processes (mirrors a real async transport).
    queueMicrotask(() => receiverRef?.handlePacket(packet));
  };

  const receiverControlSend = async (
    payload: Uint8Array,
    recipient: string,
  ): Promise<void> => {
    // The receiver addresses control frames to the sender's advertised address.
    expect(recipient).toBe("seller-nym-address");
    const packet = decodePacket(payload);
    if (!packet) return;
    queueMicrotask(() => senderRef?.handlePacket(packet));
  };

  return {
    senderRawSend,
    receiverControlSend,
    bindSender(s: { handlePacket(p: NymTransferPacket): void }) {
      senderRef = s;
    },
    bindReceiver(r: { handlePacket(p: NymTransferPacket): void }) {
      receiverRef = r;
    },
  };
}

describe("sender <-> receiver round-trip", () => {
  it("delivers a multi-chunk file with no loss and verifies the hash", async () => {
    const ciphertext = makeBytes(32 * 1024 * 2 + 500, 3);
    const expectedSha256 = await sha256Hex(ciphertext);
    const transport = wireTransport({});

    const receiver = createNymFileReceiver(
      "order1",
      transport.receiverControlSend,
      {
        expectedSha256,
        gapTimeoutMs: 50,
      },
    );
    transport.bindReceiver(receiver);

    const sender = await startNymFileSender(
      "order1",
      ciphertext,
      transport.senderRawSend,
      {
        sleep: noSleep,
        rateBytesPerSec: 0, // disable pacing delay in test
        senderAddress: "seller-nym-address",
      },
    );
    transport.bindSender(sender);

    const received = await receiver.done();
    await sender.done();
    expect(Array.from(received)).toEqual(Array.from(ciphertext));
  });

  it("repairs dropped chunks via Retransmit (simulated loss)", async () => {
    const ciphertext = makeBytes(32 * 1024 * 5 + 17, 11);
    const expectedSha256 = await sha256Hex(ciphertext);

    // Drop chunk seq 2 the FIRST time only; let the retransmit through.
    const dropped = new Set<number>();
    const transport = wireTransport({
      shouldDropSenderPacket: (packet) => {
        if (
          packet.type === PacketType.Chunk &&
          packet.seq === 2 &&
          !dropped.has(2)
        ) {
          dropped.add(2);
          return true;
        }
        return false;
      },
    });

    const receiver = createNymFileReceiver(
      "order2",
      transport.receiverControlSend,
      {
        expectedSha256,
        gapTimeoutMs: 20, // ask quickly so the test completes fast
      },
    );
    transport.bindReceiver(receiver);

    const sender = await startNymFileSender(
      "order2",
      ciphertext,
      transport.senderRawSend,
      {
        sleep: noSleep,
        rateBytesPerSec: 0,
        senderAddress: "seller-nym-address",
        retransmitWindow: 2,
      },
    );
    transport.bindSender(sender);

    const received = await receiver.done();
    await sender.done();
    expect(dropped.has(2)).toBe(true); // we really dropped it
    expect(Array.from(received)).toEqual(Array.from(ciphertext));
  });

  it("rejects on a SHA-256 mismatch", async () => {
    const ciphertext = makeBytes(32 * 1024 + 9, 5);
    const transport = wireTransport({});
    const receiver = createNymFileReceiver(
      "order3",
      transport.receiverControlSend,
      {
        expectedSha256: "deadbeef".repeat(8), // wrong hash
        gapTimeoutMs: 50,
      },
    );
    transport.bindReceiver(receiver);
    const sender = await startNymFileSender(
      "order3",
      ciphertext,
      transport.senderRawSend,
      {
        sleep: noSleep,
        rateBytesPerSec: 0,
        senderAddress: "seller-nym-address",
      },
    );
    transport.bindSender(sender);

    await expect(receiver.done()).rejects.toThrow(/sha-256 mismatch/);
  });

  it("reports progress to both sides", async () => {
    const ciphertext = makeBytes(32 * 1024 * 3, 13);
    const transport = wireTransport({});
    const receiverProgress: Array<[number, number]> = [];
    const senderProgress: Array<[number, number]> = [];

    const receiver = createNymFileReceiver(
      "order4",
      transport.receiverControlSend,
      {
        gapTimeoutMs: 50,
        onProgress: (received, total) =>
          receiverProgress.push([received, total]),
      },
    );
    transport.bindReceiver(receiver);
    const sender = await startNymFileSender(
      "order4",
      ciphertext,
      transport.senderRawSend,
      {
        sleep: noSleep,
        rateBytesPerSec: 0,
        senderAddress: "seller-nym-address",
        onProgress: (sent, total) => senderProgress.push([sent, total]),
      },
    );
    transport.bindSender(sender);

    await receiver.done();
    await sender.done();
    expect(senderProgress.at(-1)).toEqual([3, 3]);
    expect(receiverProgress.at(-1)?.[0]).toBe(3);
    expect(receiverProgress.at(-1)?.[1]).toBe(3);
  });

  it("aborts cleanly so a caller can fall back", async () => {
    const transport = wireTransport({ shouldDropSenderPacket: () => true });
    const receiver = createNymFileReceiver(
      "order5",
      transport.receiverControlSend,
      {
        gapTimeoutMs: 10_000,
        overallTimeoutMs: 10_000,
      },
    );
    transport.bindReceiver(receiver);
    const pending = receiver.done();
    receiver.abort("fallback to https");
    await expect(pending).rejects.toThrow(/aborted|fallback/);
  });

  it("repairs a run of consecutive dropped chunks", async () => {
    const ciphertext = makeBytes(32 * 1024 * 6 + 33, 23);
    const expectedSha256 = await sha256Hex(ciphertext);
    // Drop chunks 1,2,3 the FIRST time each; let the retransmits through.
    const droppedOnce = new Set<number>();
    const transport = wireTransport({
      shouldDropSenderPacket: (packet) => {
        if (
          packet.type === PacketType.Chunk &&
          [1, 2, 3].includes(packet.seq) &&
          !droppedOnce.has(packet.seq)
        ) {
          droppedOnce.add(packet.seq);
          return true;
        }
        return false;
      },
    });
    const receiver = createNymFileReceiver(
      "orderRun",
      transport.receiverControlSend,
      { expectedSha256, gapTimeoutMs: 15 },
    );
    transport.bindReceiver(receiver);
    const sender = await startNymFileSender(
      "orderRun",
      ciphertext,
      transport.senderRawSend,
      {
        sleep: noSleep,
        rateBytesPerSec: 0,
        senderAddress: "seller-nym-address",
        retransmitWindow: 4,
      },
    );
    transport.bindSender(sender);
    const received = await receiver.done();
    await sender.done();
    expect(droppedOnce.size).toBe(3);
    expect(Array.from(received)).toEqual(Array.from(ciphertext));
  });

  it("finalizes when chunks arrive before the Offer (out-of-order Offer)", async () => {
    // Buffer EVERY sender packet, then replay chunks first and the Offer last so
    // the receiver sees data before it has learned `total` or the sender address.
    const ciphertext = makeBytes(32 * 1024 * 2 + 7, 41);
    const expectedSha256 = await sha256Hex(ciphertext);
    const buffered: NymTransferPacket[] = [];
    const receiver = createNymFileReceiver(
      "orderOOO",
      async () => undefined, // no control frames needed: no loss
      { expectedSha256, gapTimeoutMs: 10_000 },
    );
    await startNymFileSender(
      "orderOOO",
      ciphertext,
      async (payload) => {
        const packet = decodePacket(payload);
        if (packet) buffered.push(packet);
      },
      {
        sleep: noSleep,
        rateBytesPerSec: 0,
        senderAddress: "seller-nym-address",
      },
    );
    // Let the background stream enqueue offer + chunks + done.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const offer = buffered.filter((p) => p.type === PacketType.Offer);
    const rest = buffered.filter((p) => p.type !== PacketType.Offer);
    // Deliver chunks/done FIRST, then the Offer.
    for (const packet of rest) receiver.handlePacket(packet);
    for (const packet of offer) receiver.handlePacket(packet);
    const received = await receiver.done();
    expect(Array.from(received)).toEqual(Array.from(ciphertext));
  });
});

describe("pacing", () => {
  it("sleeps between chunks at the configured rate", async () => {
    const ciphertext = makeBytes(32 * 1024 * 3, 21);
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => undefined);
    const sends: Uint8Array[] = [];
    const rawSend = async (payload: Uint8Array): Promise<void> => {
      sends.push(payload);
    };
    const sender = await startNymFileSender("orderP", ciphertext, rawSend, {
      sleep,
      rateBytesPerSec: 32 * 1024, // 1 chunk/sec -> ~1000ms sleep per chunk
      ackTimeoutMs: 50,
    });
    // Let the background stream run.
    await new Promise((resolve) => setTimeout(resolve, 20));
    // 3 chunks -> at least 2 inter-chunk sleeps (none after the last).
    expect(sleep.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(sleep.mock.calls[0]?.[0]).toBeGreaterThanOrEqual(900);
    void sender.done().catch(() => undefined);
  });
});
