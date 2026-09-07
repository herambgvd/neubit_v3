// Date formatting and the ONE derived fact this table needs.

import type { ApiKeyOut } from "../types";

// Date-only formatter for key created/last-used columns. Kept local (not the
// shared fmtDateTime, which adds a time component) to preserve this view's
// year-bearing, date-only labels.
export function fmtDate(v?: string | number | Date | null): string {
  if (!v) return "—";
  const d = new Date(v);
  return isNaN(d.getTime())
    ? "—"
    : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export type ApiKeyStatus = "active" | "expired" | "revoked";

/**
 * What the server would do with this key if it were presented right now.
 *
 * The table used to render `is_active` alone, so a key past its `expires_at`
 * showed as ACTIVE while every request carrying it was refused — the screen
 * asserted a key worked when it did not. The backend's own rule is
 * `ApiKey.usable_at` (auth/models.py): not revoked, not deactivated, not past
 * expiry. This mirrors it, and the order matters — a revoked key that also
 * expired is revoked, because that is the fact an operator acted on.
 */
export function apiKeyStatus(key: ApiKeyOut, now: Date = new Date()): ApiKeyStatus {
  if (!key.is_active || key.revoked_at) return "revoked";
  if (key.expires_at && new Date(key.expires_at).getTime() <= now.getTime()) return "expired";
  return "active";
}
