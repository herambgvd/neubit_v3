"use client";

// License-specific formatting helpers: a friendly date-time and the status badge.
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

export function statusBadge(lic: Partial<Pick<LicenseStatus, "dev" | "is_expired">>) {
  if (lic.dev) return <Badge color="slate">Dev / unlicensed</Badge>;
  if (lic.is_expired) return <Badge color="red">Expired</Badge>;
  return <Badge color="green">Active</Badge>;
}
