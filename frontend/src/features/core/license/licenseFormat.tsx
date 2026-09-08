"use client";

// License-specific formatting: dates, the remaining-time reading, and the status
// chip both licence sources share.
import { Badge } from "@/components/ui/kit";
import type { LicenseStatus } from "../types";

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export interface Remaining {
  /** Whole days left; negative once expired. */
  days: number;
  /** What to show under the expiry date. */
  label: string;
  /** Colour class for that label. */
  tone: string;
}

/**
 * How long is left on a licence.
 *
 * The page used to print an expiry DATE and nothing else, which is the one form
 * an operator has to do arithmetic on. "Expires in 6 days" is what decides
 * whether today is the day to chase a renewal — and the warning tone at 30 days
 * is why the reading exists at all.
 */
export function remaining(iso: string | null | undefined, now: number = Date.now()): Remaining | null {
  if (!iso) return null;
  const end = new Date(iso).getTime();
  if (Number.isNaN(end)) return null;
  const days = Math.floor((end - now) / 86_400_000);
  if (days < 0) return { days, label: `Expired ${Math.abs(days)}d ago`, tone: "text-nb-crit" };
  if (days === 0) return { days, label: "Expires today", tone: "text-nb-crit" };
  if (days <= 30) return { days, label: `${days} days left`, tone: "text-nb-warn" };
  return { days, label: `${days} days left`, tone: "text-nb-faint" };
}

export function statusBadge(lic: Partial<Pick<LicenseStatus, "dev" | "is_expired">>) {
  if (lic.dev) return <Badge color="slate">Dev / unlicensed</Badge>;
  if (lic.is_expired) return <Badge color="red">Expired</Badge>;
  return <Badge color="green">Active</Badge>;
}
