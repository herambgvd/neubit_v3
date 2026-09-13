/**
 * `accountStatus` decides the word, the badge colour and the dot on three
 * different screens, and the one thing it must get right is PRECEDENCE: the
 * backend leaves `is_active` true on a locked account, so a lock that loses to
 * the active flag shows a locked-out operator as a green, signed-in-able user —
 * and preselects "ACTIVE" in the very segment an admin uses to unlock them.
 */
import { describe, expect, it } from "vitest";

import { accountStatus } from "./format";

describe("accountStatus", () => {
  it("reports a lock even while the account is still flagged active", () => {
    expect(accountStatus({ locked: true, is_active: true })).toBe("locked");
    expect(accountStatus({ locked: true, is_active: false })).toBe("locked");
  });

  it("separates active from disabled when there is no lock", () => {
    expect(accountStatus({ locked: false, is_active: true })).toBe("active");
    expect(accountStatus({ locked: false, is_active: false })).toBe("disabled");
  });

  it("treats an absent flag as not set rather than as a lock", () => {
    expect(accountStatus({ locked: null, is_active: true })).toBe("active");
    expect(accountStatus({ locked: undefined, is_active: undefined })).toBe("disabled");
  });
});
