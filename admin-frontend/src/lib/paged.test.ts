import { describe, expect, it } from "vitest";

import { pagedItems, pagedSize, pagedTotal } from "@/lib/paged";

// Some list endpoints answer with an envelope and some with a bare array; every
// page reads them through these helpers, so both shapes are pinned here.
describe("paged helpers", () => {
  const envelope = { items: [{ id: "a" }, { id: "b" }], total: 57, page: 2, page_size: 20 };

  it("reads rows from the envelope", () => {
    expect(pagedItems(envelope)).toHaveLength(2);
    expect(pagedTotal(envelope)).toBe(57);
    expect(pagedSize(envelope)).toBe(20);
  });

  it("reads rows from a bare array", () => {
    const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(pagedItems(rows)).toBe(rows);
    // A bare array is the whole result, so its length IS the total.
    expect(pagedTotal(rows)).toBe(3);
    expect(pagedSize(rows, 25)).toBe(25);
  });

  it("survives undefined, null and a malformed envelope", () => {
    expect(pagedItems(undefined)).toEqual([]);
    expect(pagedItems(null)).toEqual([]);
    expect(pagedTotal(undefined)).toBe(0);
    // items missing entirely — must not throw on the way to an empty table.
    expect(pagedItems({ total: 3, page: 1, page_size: 20 } as never)).toEqual([]);
  });

  it("falls back to the row count when the server omits a total", () => {
    expect(pagedTotal({ items: [{ id: "a" }], page: 1, page_size: 20 } as never)).toBe(1);
  });
});
