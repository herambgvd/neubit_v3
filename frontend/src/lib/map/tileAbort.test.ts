/**
 * Zooming the map cancels every in-flight tile request. That is how a map works,
 * not a fault — but the cancellation surfaced as an unhandled AbortError, and
 * Next's dev overlay turns one of those into a blocking modal over the map.
 *
 * The rule under test is the NARROWNESS of the suppression: a cancelled tile is
 * swallowed, and nothing else is. Widening it would hide real failures behind the
 * same silence.
 */
import { describe, expect, it } from "vitest";

import { isTileAbort } from "./config";

describe("isTileAbort", () => {
  it("matches the browser's own abort, which is a DOMException", () => {
    // Chrome throws exactly this when a signal is aborted with no reason — the
    // string in the report the operator sent.
    expect(isTileAbort(new DOMException("signal is aborted without reason", "AbortError"))).toBe(true);
  });

  it("matches an abort that arrives as a plain Error", () => {
    // MapLibre defines its OWN `class AbortError extends Error`, so the object
    // reaching the handler is not always a DOMException. Matching on `name` is
    // what covers both; `instanceof DOMException` would miss maplibre's, and
    // `instanceof Error` misses DOMException under jsdom.
    const err = new Error("aborted");
    err.name = "AbortError";
    expect(isTileAbort(err)).toBe(true);
  });

  it("does NOT match a real failure", () => {
    expect(isTileAbort(new Error("Failed to fetch"))).toBe(false);
    expect(isTileAbort(new TypeError("range request refused"))).toBe(false);
    const http = new Error("404");
    http.name = "AJAXError";
    expect(isTileAbort(http)).toBe(false);
  });

  it("does not match a bare string or a nullish reason", () => {
    expect(isTileAbort("AbortError")).toBe(false);
    expect(isTileAbort(null)).toBe(false);
    expect(isTileAbort(undefined)).toBe(false);
  });
});
