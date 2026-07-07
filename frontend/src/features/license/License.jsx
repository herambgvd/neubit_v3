"use client";

// License — review license status and apply renewals. Thin orchestrator: owns
// the license query, the token input state and the apply mutation; wires the
// LicenseOverview (status/modules/features) + UpdateLicensePanel columns.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { PageHeader, Spinner } from "@/components/ui/kit";
import { api, apiError } from "@/lib/api";
import LicenseOverview from "./components/LicenseOverview";
import UpdateLicensePanel from "./components/UpdateLicensePanel";

export default function LicensePage() {
  const qc = useQueryClient();
  const [token, setToken] = useState("");

  const license = useQuery({
    queryKey: ["license"],
    queryFn: () => api.get("/license").then((r) => r.data),
  });

  const apply = useMutation({
    mutationFn: (body) => api.post("/license", body),
    onSuccess: () => {
      toast.success("License updated");
      qc.invalidateQueries({ queryKey: ["license"] });
      setToken("");
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const lic = license.data;

  return (
    <div>
      <PageHeader
        title="License"
        subtitle="Review your license status and apply renewals."
      />

      {license.isLoading ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-3">
          <LicenseOverview lic={lic} />
          <UpdateLicensePanel
            token={token}
            setToken={setToken}
            onApply={() => apply.mutate({ token: token.trim() })}
            applying={apply.isPending}
          />
        </div>
      )}
    </div>
  );
}
