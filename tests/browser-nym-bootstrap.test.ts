// FIX A: gateway-rotation retry in the browser Nym bootstrap.
// The per-attempt helper starts a client and polls selfAddress(). On a bad
// gateway selfAddress() stays empty; the bootstrap then rotates to a fresh
// client. This proves the helper polls until the gateway handshake yields an
// address (the inner loop of the retry), using a fake client so no real SDK or
// React state is involved.

import { describe, expect, it, vi } from "vitest";

import {
  startAndAwaitNymAddress,
  type StartableNymClient,
} from "../app/components/paid-private-file/paid-private-file-panel";

describe("startAndAwaitNymAddress", () => {
  it("polls selfAddress() until the gateway returns an address", async () => {
    // selfAddress() is empty on the first read (handshake not done yet) and a
    // real address on the second read.
    const selfAddress = vi
      .fn<() => Promise<string | undefined>>()
      .mockResolvedValueOnce("")
      .mockResolvedValue("nym1realaddress000000000000000000000000000000");
    const start = vi
      .fn<(opts?: Record<string, unknown>) => Promise<void>>()
      .mockResolvedValue(undefined);
    const client: StartableNymClient = {
      client: { start, selfAddress },
    };

    const address = await startAndAwaitNymAddress(client, {
      clientId: "test-client",
      // Skip the real 1s sleep so the test runs instantly.
      waitMs: async () => undefined,
    });

    expect(start).toHaveBeenCalledOnce();
    expect(address).toBe("nym1realaddress000000000000000000000000000000");
    expect(selfAddress.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
