/**
 * The email check replaced five regexes that disagreed with each other, and three
 * that could backtrack super-linearly. So there are two things to pin: that it
 * accepts and refuses the right things, and that it does so in linear time — the
 * case a regex-shaped implementation fails and a structural one cannot.
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

  it("stays linear on the input that made the old regex backtrack", () => {
    // `[^\s@]+@[^\s@]+\.[^\s@]+` on "a@" + 60k non-dot characters makes the
    // engine try every split of the tail. Structurally there is nothing to try.
    const evil = `a@${"b".repeat(60_000)}`;
    const started = performance.now();
    expect(isEmail(evil)).toBe(false);
    expect(performance.now() - started).toBeLessThan(50);
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

  it("is linear on a long run", () => {
    const started = performance.now();
    expect(trimChars("-".repeat(200_000) + "x", "-")).toBe("x");
    expect(performance.now() - started).toBeLessThan(50);
  });
});
