/**
 * The four verdicts this posture band prints. Every one of them has a state that
 * must NOT be read as "fine":
 *
 *   - an integration that is configured but switched off,
 *   - a two-factor policy that is required of nobody in particular,
 *   - an audit retention of 0, which means keep forever rather than keep nothing,
 *   - a licence that has not loaded, as against one with no expiry at all.
 *
 * A posture dashboard is only worth reading if those four stay distinguishable,
 * so they are pinned here rather than left to a chain in the markup.
 */
import { describe, expect, it } from "vitest";

import { configuredLabel, licenseExpiry, retentionLabel, twoFactorScope } from "./SystemAssurance";

describe("configuredLabel", () => {
  it("separates never-set-up from set-up-but-off", () => {
    expect(configuredLabel(null)).toBe("OFF");
    expect(configuredLabel(undefined)).toBe("OFF");
    expect(configuredLabel({ enabled: false })).toBe("CONFIGURED");
    expect(configuredLabel({ enabled: true })).toBe("ENABLED");
  });
});

describe("twoFactorScope", () => {
  it("names the roles when the policy names them", () => {
    expect(twoFactorScope(true, ["Administrator", "Operator"])).toBe("Administrator, Operator");
  });

  it("says Everyone for a requirement with no role list, not 'all'", () => {
    expect(twoFactorScope(true, [])).toBe("Everyone");
    expect(twoFactorScope(true, null)).toBe("Everyone");
  });

  it("does not let a leftover role list imply a requirement that is off", () => {
    expect(twoFactorScope(false, ["Administrator"])).toBe("Not required");
    expect(twoFactorScope(undefined, null)).toBe("Not required");
  });
});

describe("retentionLabel", () => {
  it("reads 0 as Forever — the value where the number says the opposite", () => {
    expect(retentionLabel(0)).toBe("Forever");
    expect(retentionLabel("0")).toBe("Forever");
  });

  it("prints a real retention in days", () => {
    expect(retentionLabel(90)).toBe("90 days");
  });

  it("shows a dash when the setting has not been read", () => {
    expect(retentionLabel(null)).toBe("—");
    expect(retentionLabel(undefined)).toBe("—");
  });
});

describe("licenseExpiry", () => {
  it("tells a perpetual licence apart from one that has not loaded", () => {
    expect(licenseExpiry({ expires_at: null })).toBe("perpetual");
    expect(licenseExpiry(null)).toBe("—");
  });

  it("dates an expiring licence", () => {
    expect(licenseExpiry({ expires_at: "2030-01-15T00:00:00Z" })).toMatch(/^expires /);
  });
});
