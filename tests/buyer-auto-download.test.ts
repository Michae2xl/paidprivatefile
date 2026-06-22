// The dead-simple buyer flow auto-saves the decrypted file the instant it
// arrives over Nym: openClaimPayload calls triggerBrowserDownload, which wires a
// temporary <a download={fileName} href={url}>, appends it, clicks it, and
// removes it — so the file saves WITHOUT a click. These tests pin that wiring
// (and its no-throw safety on a server / blocked-click) without a real DOM; the
// test environment is "node", so we inject a minimal fake document.

import { afterEach, describe, expect, it, vi } from "vitest";

import { triggerBrowserDownload } from "../app/components/paid-private-file/paid-private-file-panel";

const originalDocument = (globalThis as { document?: unknown }).document;

afterEach(() => {
  if (originalDocument === undefined) {
    delete (globalThis as { document?: unknown }).document;
  } else {
    (globalThis as { document?: unknown }).document = originalDocument;
  }
});

describe("triggerBrowserDownload", () => {
  it("creates a download anchor, clicks it, and removes it", () => {
    const click = vi.fn();
    const anchor: Record<string, unknown> = { style: {}, click };
    const appendChild = vi.fn();
    const removeChild = vi.fn();

    (globalThis as { document?: unknown }).document = {
      createElement: vi.fn(() => anchor),
      body: { appendChild, removeChild },
    };

    triggerBrowserDownload("blob:abc", "secret.png");

    expect(anchor.href).toBe("blob:abc");
    expect(anchor.download).toBe("secret.png");
    expect(appendChild).toHaveBeenCalledWith(anchor);
    expect(click).toHaveBeenCalledTimes(1);
    expect(removeChild).toHaveBeenCalledWith(anchor);
  });

  it("is a no-op (no throw) when there is no document (server render)", () => {
    delete (globalThis as { document?: unknown }).document;
    expect(() => triggerBrowserDownload("blob:abc", "f.bin")).not.toThrow();
  });

  it("never throws when the click is blocked (Safari) — fallback button covers it", () => {
    const anchor: Record<string, unknown> = {
      style: {},
      click: () => {
        throw new Error("blocked");
      },
    };
    (globalThis as { document?: unknown }).document = {
      createElement: () => anchor,
      body: { appendChild: vi.fn(), removeChild: vi.fn() },
    };
    expect(() => triggerBrowserDownload("blob:abc", "f.bin")).not.toThrow();
  });
});
