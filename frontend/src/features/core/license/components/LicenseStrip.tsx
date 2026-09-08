"use client";

// The one-line answer: who this is licensed to, whether it is valid, until when,
// and the two limits anyone actually asks about.
//
// The expiry reads as a COUNTDOWN as well as a date. "12 Mar 2027" is a fact an
// operator has to do arithmetic on; "43 days left", amber under thirty, is the
// bit that decides whether today is the day to chase the renewal.
import { Icon } from "@iconify/react";

import { SectionCard } from "@/components/console";
import { useAuth } from "@/lib/auth";
import type { LicenseStatus } from "../../types";
import { fmtDate, remaining, statusBadge } from "../licenseFormat";

function Cell({
  icon,
  label,
  value,
  sub,
  subTone = "text-nb-faint",
}: {
  icon: string;
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  subTone?: string;
}) {
  return (
    <div className="flex items-start gap-2.5 px-4 py-3">
      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-nb-blue/12 text-nb-blueb">
        <Icon icon={icon} className="text-base" />
      </span>
      <div className="min-w-0">
        <p className="text-[10px] font-semibold uppercase tracking-[1.2px] text-nb-muted">{label}</p>
        <p className="truncate text-[13.5px] font-medium text-nb-ink">{value}</p>
        {sub && <p className={`truncate text-[11px] ${subTone}`}>{sub}</p>}
      </div>
    </div>
  );
}

export default function LicenseStrip({ lic }: { lic: LicenseStatus | undefined }) {
  const { entitlements } = useAuth();
  // The tenant's own expiry wins where there is one: a tenant can be wound down
  // inside a platform licence that runs for another year.
  const expiry = entitlements?.expires_at || lic?.expires_at || null;
  const left = remaining(expiry);
  const cameras = lic?.limits?.cameras ?? entitlements?.limits?.cameras;
  const storage = lic?.limits?.storage_gb ?? entitlements?.limits?.storage_gb;

  return (
    <SectionCard className="!p-0">
      <div className="grid divide-y divide-nb-line sm:grid-cols-2 sm:divide-y-0 xl:grid-cols-4 xl:divide-x">
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-[1.2px] text-nb-muted">
              Licensed to
            </p>
            <p className="truncate text-[15px] font-semibold text-nb-ink">
              {lic?.client || entitlements?.plan || "—"}
            </p>
          </div>
          {statusBadge(lic || {})}
        </div>

        <Cell
          icon="heroicons-outline:calendar-days"
          label="Expires"
          value={expiry ? fmtDate(expiry) : "Perpetual"}
          sub={left?.label}
          subTone={left?.tone}
        />
        <Cell
          icon="heroicons-outline:video-camera"
          label="Cameras"
          value={cameras ?? "Unlimited"}
        />
        <Cell
          icon="heroicons-outline:circle-stack"
          label="Storage"
          value={storage != null ? `${storage} GB` : "Unlimited"}
        />
      </div>

      {lic?.dev && (
        <div className="flex items-start gap-2 border-t border-nb-line bg-white/[.03] px-4 py-2.5 text-[12px] text-nb-muted">
          <Icon icon="heroicons-outline:information-circle" className="mt-0.5 shrink-0 text-sm" />
          <span>
            Development mode — this deployment is unlicensed and every limit above is
            ignored. Apply a signed token to activate a production license.
          </span>
        </div>
      )}
    </SectionCard>
  );
}
