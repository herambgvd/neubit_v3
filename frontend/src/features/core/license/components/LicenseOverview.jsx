"use client";

// Left column of the License page: status card (licensed-to + expiry/camera/
// storage stats + dev-mode notice), enabled modules, and feature flags.
import { Icon } from "@iconify/react";

import { Badge, Card } from "@/components/ui/kit";
import { fmtDate, statusBadge } from "../licenseFormat";
import Stat from "./Stat";

export default function LicenseOverview({ lic }) {
  return (
    <div className="lg:col-span-2 space-y-6">
      {/* Status */}
      <Card className="p-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted">
              Licensed to
            </p>
            <h3 className="text-lg font-semibold text-foreground text-foreground mt-0.5">
              {lic?.client || "—"}
            </h3>
          </div>
          {statusBadge(lic || {})}
        </div>

        <div className="mt-5 grid gap-4 sm:grid-cols-2">
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
          <div className="mt-5 flex items-start gap-2 rounded-lg bg-hover bg-hover px-4 py-3 text-sm text-muted text-muted">
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
      </Card>

      {/* Modules */}
      <Card className="p-6">
        <h3 className="text-base font-semibold text-foreground mb-3">Modules</h3>
        {lic?.modules?.length ? (
          <div className="flex flex-wrap gap-2">
            {lic.modules.map((m) => (
              <Badge key={m} color="indigo">
                {m}
              </Badge>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted">No modules enabled.</p>
        )}
      </Card>

      {/* Features */}
      <Card className="p-6">
        <h3 className="text-base font-semibold text-foreground mb-3">Features</h3>
        {lic?.features && Object.keys(lic.features).length ? (
          <ul className="space-y-2">
            {Object.entries(lic.features).map(([key, val]) => {
              const on = Boolean(val);
              return (
                <li key={key} className="flex items-center gap-2 text-sm">
                  <Icon
                    icon={on ? "heroicons-outline:check-circle" : "heroicons-outline:x-circle"}
                    className={`text-base ${on ? "text-green-500" : "text-muted text-muted"}`}
                  />
                  <span className="text-foreground text-foreground">{key}</span>
                  {typeof val !== "boolean" && (
                    <span className="ml-auto text-muted">{String(val)}</span>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-sm text-muted">No features listed.</p>
        )}
      </Card>
    </div>
  );
}
