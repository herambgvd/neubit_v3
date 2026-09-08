/**
 * The designer's document model.
 *
 * Two properties carry the whole feature. ROUND-TRIP: what the designer produces
 * must come back as exactly the blocks that made it, or an operator's work is
 * silently altered on reopen. REFUSAL: HTML that was NOT produced here must come
 * back as null, because approximating someone else's markup as blocks loses
 * whatever it cannot represent the moment they press save.
 */
import { describe, expect, it } from "vitest";

import { blocksToHtml, escapeText, htmlToBlocks, newBlock, safeUrl, type Block } from "./blocks";

const doc: Block[] = [
  { id: "a", type: "heading", text: "Hello {{ name }}", level: 2, align: "center" },
  { id: "b", type: "text", text: "Line one\nline two" },
  { id: "c", type: "button", text: "Open", url: "https://example.com" },
  { id: "d", type: "divider" },
];

describe("round-tripping a design", () => {
  it("reads back exactly the blocks it wrote", () => {
    expect(htmlToBlocks(blocksToHtml(doc))).toEqual(doc);
  });

  it("treats an EMPTY design as a design, not as foreign HTML", () => {
    // "Start a design" produces exactly this. Reading it back as null sent the
    // operator straight back to the not-built-here screen after their first save.
    expect(blocksToHtml([])).toContain("nb-blocks:");
    expect(htmlToBlocks(blocksToHtml([]))).toEqual([]);
  });

  it("refuses HTML it did not produce, instead of guessing at blocks", () => {
    expect(htmlToBlocks("<h2>{{ title }}</h2><p>{% if x %}y{% endif %}</p>")).toBeNull();
    expect(htmlToBlocks("")).toBeNull();
  });

  it("refuses a marker whose payload is not a block list", () => {
    expect(htmlToBlocks("<!--nb-blocks:not json-->x")).toBeNull();
    expect(htmlToBlocks('<!--nb-blocks:{"a":1}-->x')).toBeNull();
  });

  it("keeps a design open across a save-and-reopen of an empty one", () => {
    const saved = blocksToHtml([]);
    const reopened = htmlToBlocks(saved);
    expect(reopened).not.toBeNull();
    expect(htmlToBlocks(blocksToHtml(reopened!))).toEqual([]);
  });

  it("drops an entry that is not a block rather than rendering an invisible one", () => {
    const mixed = `<!--nb-blocks:${JSON.stringify([doc[0], { id: "x" }, { type: "nope" }])}-->`;
    expect(htmlToBlocks(mixed)).toEqual([doc[0]]);
  });
});

describe("the HTML it produces", () => {
  it("renders each block type", () => {
    const html = blocksToHtml(doc);
    expect(html).toContain("<h2");
    expect(html).toContain("Line one<br>line two");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain("<hr");
  });

  it("keeps the placeholder intact — escaping it would break the substitution", () => {
    // `{{ name }}` must reach the server as-is; `&#123;&#123;` never substitutes.
    expect(blocksToHtml([doc[0]])).toContain("Hello {{ name }}");
  });

  it("escapes markup an operator types, since this is rendered in a mail client", () => {
    expect(escapeText('<script>alert(1)</script>')).toBe(
      "&lt;script&gt;alert(1)&lt;/script&gt;",
    );
    expect(blocksToHtml([{ id: "z", type: "text", text: "<b>x</b>" }])).toContain("&lt;b&gt;x&lt;/b&gt;");
  });

  it("leaves out a button or image with no usable link, rather than emitting a broken one", () => {
    expect(blocksToHtml([{ id: "z", type: "button", text: "Go", url: "" }])).not.toContain("<a");
    expect(blocksToHtml([{ id: "z", type: "image", url: "" }])).not.toContain("<img");
  });
});

describe("safeUrl", () => {
  it("takes http(s) and a bare placeholder", () => {
    expect(safeUrl("https://example.com")).toBe("https://example.com");
    expect(safeUrl("http://example.com")).toBe("http://example.com");
    expect(safeUrl("{{ login_url }}")).toBe("{{ login_url }}");
  });

  it("refuses a scheme that executes", () => {
    expect(safeUrl("javascript:alert(1)")).toBe("");
    expect(safeUrl("data:text/html,<script>x</script>")).toBe("");
    expect(safeUrl("  JavaScript:alert(1)")).toBe("");
  });
});

describe("newBlock", () => {
  it("gives every block a distinct id, so React and the reorder keep them apart", () => {
    const ids = new Set([newBlock("text").id, newBlock("text").id, newBlock("text").id]);
    expect(ids.size).toBe(3);
  });

  it("starts each type with something usable rather than an empty shell", () => {
    expect(newBlock("heading").text).toBeTruthy();
    expect(newBlock("button").url).toBeTruthy();
  });
});
