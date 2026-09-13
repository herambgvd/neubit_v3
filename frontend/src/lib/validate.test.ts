/**
 * The email check replaced five regexes that disagreed with each other, and three
 * that could backtrack super-linearly. So there are two things to pin: that it
 * accepts and refuses the right things, and that it still answers on the input
 * that made those regexes hang — the case a regex-shaped implementation fails and
 * a structural one cannot.
 */
import { describe, expect, it } from "vitest";

import { isEmail, trimChars, trimEnd } from "./validate";

describe("isEmail", () => {
  it.each([
    "dave@corp.io",
    "dave.smith@corp.io",
    "dave+alarms@corp.co.uk",
    "d@a.b",
    "  dave@corp.io  ", // trimmed, because a pasted address usually is not
  ])("accepts %s", (v) => expect(isEmail(v)).toBe(true));

  it.each([
    ["", "empty"],
    ["dave", "no @"],
    ["@corp.io", "no local part"],
    ["dave@", "no domain"],
    ["dave@corp", "no dot in the domain"],
    ["dave@@corp.io", "two @"],
    ["dave@a@b.io", "two @ further apart"],
    ["dave@.io", "empty first label"],
    ["dave@corp.", "empty last label"],
    ["dave@corp..io", "empty middle label"],
    ["da ve@corp.io", "space in the local part"],
    ["dave@co rp.io", "space in the domain"],
    ["dave@corp.io\t", "tab, which trim removes — but not an inner one"],
  ])("refuses %s (%s)", (v) => expect(isEmail(v)).toBe(v === "dave@corp.io\t"));

  it.each([
    "mohit😀@example.com",
    "dave@exämple.com",
    "dаve@corp.io", // Cyrillic а — identical at a glance to the Latin one
  ])("refuses the non-ASCII address %s", (v) => {
    // Not tidiness. An emoji address validated once and an account was created
    // under something no mail server here delivers to; the homoglyph is worse,
    // because it is indistinguishable from a real colleague in a user list.
    // core/fields.AsciiEmail enforces the same rule on the API.
    expect(isEmail(v)).toBe(false);
  });

  it("answers on the input that made the old regex backtrack", () => {
    // `[^\s@]+@[^\s@]+\.[^\s@]+` on "a@" + a long run of non-dot characters makes
    // the engine try every split of the tail. Structurally there is nothing to try.
    //
    // The guard is that this RETURNS, not that it returns inside a wall-clock
    // budget. A budget cannot tell a slow algorithm from a descheduled worker: the
    // 50ms one this replaces failed at 262ms on a loaded machine with the
    // implementation untouched. The run length is chosen so the two classes cannot
    // be confused — structurally this answers in microseconds, while the regex
    // above measures 12.6 SECONDS on it, which the test timeout catches outright.
    const evil = `a@${"b".repeat(120_000)}`;
    expect(isEmail(evil)).toBe(false);
  });
});

describe("trimChars / trimEnd", () => {
  it("removes runs from both ends, and nothing from the middle", () => {
    expect(trimChars("__a_b__", "_")).toBe("a_b");
    expect(trimChars("---x---", "-")).toBe("x");
  });

  it("removes only trailing runs when asked", () => {
    expect(trimEnd("/a/b///", "/")).toBe("/a/b");
    expect(trimEnd("host...", ".")).toBe("host");
  });

  it("survives a string that is entirely the stripped character", () => {
    // The two pointers must not cross — an easy off-by-one that returns garbage
    // rather than "".
    expect(trimChars("____", "_")).toBe("");
    expect(trimEnd("....", ".")).toBe("");
  });

  it("leaves a string with nothing to strip alone", () => {
    expect(trimChars("abc", "-")).toBe("abc");
    expect(trimEnd("", "/")).toBe("");
  });

  it("survives a run longer than the call stack", () => {
    // Deliberately NOT a timing claim. The two pointers are linear, but so is
    // every other way of writing this in V8 — stripping one character at a time
    // with `slice` measures 4ms on this input, because V8 slices strings in
    // constant time. The 50ms budget this replaces could not have caught the shape
    // it named; all it measured was how busy the machine was, and on a busy one it
    // failed. What a run this long does catch is a recursive rewrite, which runs
    // out of stack.
    expect(trimChars("-".repeat(200_000) + "x", "-")).toBe("x");
  });
});
