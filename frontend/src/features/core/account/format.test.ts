/**
 * `deviceLabel` names the sessions an operator is deciding whether to revoke, so
 * what is pinned here is the ORDER the User-Agent rules are tried in. Real UA
 * strings overlap on purpose — an iPhone says "Mac OS X", Edge says "Chrome/" —
 * so a table matched by best fit, or the same rows in a different order, would
 * quietly rename somebody's phone into a Mac and their Edge into Chrome.
 */
import { describe, expect, it } from "vitest";

import { deviceLabel, groupSecret } from "./format";

const UA = {
  edge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0",
  chrome: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1",
  firefoxLinux: "Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0",
  mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15",
};

describe("deviceLabel", () => {
  it("prefers the more specific rule where two match the same string", () => {
    // Both of these carry "Chrome/"; only the first also carries "Edg/".
    expect(deviceLabel(UA.edge)).toBe("Edge on Windows");
    expect(deviceLabel(UA.chrome)).toBe("Chrome on Windows");

    // And every iPhone UA also says "Mac OS X".
    expect(deviceLabel(UA.iphone)).toBe("Safari on iOS");
    expect(deviceLabel(UA.mac)).toBe("Safari on macOS");
  });

  it("reads the ordinary combinations", () => {
    expect(deviceLabel(UA.firefoxLinux)).toBe("Firefox on Linux");
  });

  it("says so rather than guessing when nothing matches", () => {
    expect(deviceLabel("curl/8.4.0")).toBe("Browser on Unknown OS");
    expect(deviceLabel(null)).toBe("Unknown device");
    expect(deviceLabel("")).toBe("Unknown device");
  });
});

describe("groupSecret", () => {
  it("blocks a base32 secret in fours with no trailing space", () => {
    expect(groupSecret("ABCDEFGHIJKLMNOP")).toBe("ABCD EFGH IJKL MNOP");
    expect(groupSecret(null)).toBe("");
  });
});
