"use client";

// Left column of the License page: status card (licensed-to + expiry/camera/
// storage stats + dev-mode notice), enabled modules, and feature flags.
import { Icon } from "@iconify/react";

import { SectionCard, SectionHead } from "@/components/console";
import { Badge } from "@/components/ui/kit";
import { fmtDate, statusBadge } from "../licenseFormat";
import Stat from "./Stat";

export default function LicenseOverview({ lic }: any) {
  return (
    <div className="space-y-3 lg:col-span-2">
      {/* Status */}
      <SectionCard>
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-[1.3px] text-nb-muted">
              Licensed to
            </div>
            <h3 className="mt-0.5 text-lg font-semibold text-nb-ink">
              {lic?.client || "—"}
            </h3>
          </div>
          {statusBadge(lic || {})}
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <Stat
            icon="heroicons-outline:calendar-days"
            label="Expires"
            value={fmtDate(lic?.expires_at)}
          />
          <Stat
            icon="heroicons-outline:video-camera"
            label="Cameras"
            value={lic?.limits?.cameras ?? "—"}
          />
          <Stat
            icon="heroicons-outline:circle-stack"
            label="Storage"
            value={lic?.limits?.storage_gb != null ? `${lic.limits.storage_gb} GB` : "—"}
          />
        </div>

        {lic?.dev && (
          <div className="mt-4 flex items-start gap-2 rounded-[10px] border border-nb-line bg-white/5 px-3 py-2.5 text-[12.5px] text-nb-muted">
            <Icon
              icon="heroicons-outline:information-circle"
              className="text-base mt-0.5 shrink-0"
            />
            <span>
              Running in development mode — the app is unlicensed and all limits are
              ignored. Apply a signed token below to activate a production license.
            </span>
          </div>
        )}
      </SectionCard>

      {/* Modules */}
      <SectionCard>
        <SectionHead icon="heroicons-outline:cube" title="Modules" />
        {lic?.modules?.length ? (
          <div className="flex flex-wrap gap-2">
            {lic.modules.map((m) => (
              <Badge key={m} color="indigo">
                {m}
              </Badge>
            ))}
          </div>
        ) : (
          <p className="text-sm text-nb-muted">No modules enabled.</p>
        )}
      </SectionCard>

      {/* Features */}
      <SectionCard>
        <SectionHead icon="heroicons-outline:flag" title="Features" />
        {lic?.features && Object.keys(lic.features).length ? (
          <ul className="space-y-2">
            {Object.entries<any>(lic.features).map(([key, val]) => {
              const on = Boolean(val);
              return (
                <li key={key} className="flex items-center gap-2 text-sm">
                  <Icon
                    icon={on ? "heroicons-outline:check-circle" : "heroicons-outline:x-circle"}
                    className={`text-base ${on ? "text-nb-good" : "text-nb-faint"}`}
                  />
                  <span className="text-nb-ink">{key}</span>
                  {typeof val !== "boolean" && (
                    <span className="ml-auto text-nb-muted">{String(val)}</span>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-sm text-nb-muted">No features listed.</p>
        )}
      </SectionCard>
    </div>
  );
}
