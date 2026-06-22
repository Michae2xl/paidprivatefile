import { describe, expect, it } from "vitest";

import {
  computeNymReceiveTimeoutMs,
  NYM_RECEIVE_MAX_TIMEOUT_MS,
  NYM_RECEIVE_MIN_TIMEOUT_MS,
} from "../lib/nym-file-transfer";

const MB = 1024 * 1024;

describe("computeNymReceiveTimeoutMs", () => {
  it("returns the floor for degenerate sizes", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(computeNymReceiveTimeoutMs(bad)).toBe(NYM_RECEIVE_MIN_TIMEOUT_MS);
    }
  });

  it("floors small files at the 10 min minimum", () => {
    // ~1 MB and ~5 MB estimate well under 10 min, so they clamp to the floor.
    expect(computeNymReceiveTimeoutMs(1 * MB)).toBe(NYM_RECEIVE_MIN_TIMEOUT_MS);
    expect(computeNymReceiveTimeoutMs(5 * MB)).toBe(NYM_RECEIVE_MIN_TIMEOUT_MS);
  });

  it("scales mid-size files above the floor and below the cap", () => {
    const t20 = computeNymReceiveTimeoutMs(20 * MB);
    expect(t20).toBeGreaterThan(NYM_RECEIVE_MIN_TIMEOUT_MS);
    expect(t20).toBeLessThan(NYM_RECEIVE_MAX_TIMEOUT_MS);
    // ~20 min at the conservative 15 KiB/s sizing rate.
    expect(t20).toBeGreaterThan(20 * 60_000);
  });

  it("gives a ~50 MB file close to (but within) the 60 min cap", () => {
    const t50 = computeNymReceiveTimeoutMs(50 * MB);
    expect(t50).toBeLessThanOrEqual(NYM_RECEIVE_MAX_TIMEOUT_MS);
    // Comfortably more than the ~18 min ideal drain so a healthy transfer with
    // retransmits is never aborted onto the HTTPS fallback.
    expect(t50).toBeGreaterThan(40 * 60_000);
  });

  it("caps very large files at the 60 min maximum", () => {
    expect(computeNymReceiveTimeoutMs(500 * MB)).toBe(
      NYM_RECEIVE_MAX_TIMEOUT_MS,
    );
  });

  it("is non-decreasing in size", () => {
    let prev = 0;
    for (const mb of [1, 5, 10, 20, 30, 49, 50, 80, 200]) {
      const t = computeNymReceiveTimeoutMs(mb * MB);
      expect(t).toBeGreaterThanOrEqual(prev);
      prev = t;
    }
  });
});
