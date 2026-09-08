"use client";

// License — what this deployment is entitled to, and how to renew it.
//
// There are genuinely TWO sources here and the page used to stack them without
// saying so: the tenant's entitlements (plan, modules, quotas — from /features)
// and the platform's signed licence (client, expiry, limits — from /license).
// Read top to bottom it repeated "modules" and "expires" twice with different
// numbers, and the only actionable thing on the screen, the renewal box, sat
// open at the bottom whether or not anyone had a token to paste.
//
// So: one status strip that answers "am I licensed, until when, for how much",
// then the two sources side by side and LABELLED with where they come from, and
// the renewal behind a button — a textarea that is open by default is a form
// asking to be filled in.
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { LoadingBlock } from "@/components/console";
import { api, apiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { toast } from "sonner";

import type { LicenseStatus } from "../types";
import LicenseStrip from "./components/LicenseStrip";
import ModulesCard from "./components/ModulesCard";
import QuotasCard from "./components/QuotasCard";
import UpdateLicensePanel from "./components/UpdateLicensePanel";

export default function LicensePage() {
  const qc = useQueryClient();
  const { reload } = useAuth();
  const [token, setToken] = useState("");

  const license = useQuery({
    queryKey: ["license"],
    queryFn: () => api.get<LicenseStatus>("/license").then((r) => r.data),
  });

  // `LicenseUpdateIn` — the signed token.
  const apply = useMutation({
    mutationFn: (body: { token: string }) => api.post("/license", body),
    onSuccess: () => {
      toast.success("License updated");
      qc.invalidateQueries({ queryKey: ["license"] });
      // Entitlements are derived from the licence and live on the auth context,
      // not in the query cache — without this the old plan stays on screen (and
      // in the nav) until the next full reload.
      reload();
      setToken("");
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const lic = license.data;
  const modules = useMemo(() => lic?.modules || [], [lic]);

  if (license.isLoading) return <LoadingBlock />;

  return (
    <div className="space-y-3">
        <LicenseStrip lic={lic} />

        <div className="grid gap-3 lg:grid-cols-3">
          <ModulesCard licenseModules={modules} />
          <QuotasCard lic={lic} />
          <UpdateLicensePanel
            token={token}
            setToken={setToken}
            onApply={() => apply.mutate({ token: token.trim() })}
            applying={apply.isPending}
          />
      </div>
    </div>
  );
}
