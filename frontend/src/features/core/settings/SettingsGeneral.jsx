"use client";

// General settings — platform-wide options grouped into cards, driven by a
// server-provided catalog. Thin orchestrator: owns the config query, the local
// values buffer, and the save mutation; delegates each control to SettingField.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Card, Spinner } from "@/components/ui/kit";
import { api, apiError } from "@/lib/api";
import SettingField from "./components/SettingField";

export default function SettingsGeneralPage() {
  const qc = useQueryClient();
  const cfg = useQuery({
    queryKey: ["settings-config"],
    queryFn: () => api.get("/settings").then((r) => r.data),
  });

  const [values, setValues] = useState({});
  useEffect(() => {
    if (cfg.data?.values) setValues(cfg.data.values);
  }, [cfg.data]);

  const save = useMutation({
    mutationFn: () => api.put("/settings", { values }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings-config"] });
      qc.invalidateQueries({ queryKey: ["public-settings"] });
      toast.success("Settings saved");
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const catalog = cfg.data?.catalog || [];
  const groups = [...new Set(catalog.map((c) => c.group))];

  return (
    <div
      className="-mx-6 lg:-mx-8 -my-6 min-h-full px-6 lg:px-8 py-6 text-nb-ink"
      style={{ background: "radial-gradient(1200px 700px at 50% 115%, #14284f 0%, #0c1530 55%)" }}
    >
      <div className="mb-4 flex items-center justify-end">
        <button
          disabled={save.isPending || cfg.isLoading}
          onClick={() => save.mutate()}
          className="inline-flex items-center gap-1.5 rounded-[9px] border border-[rgba(34,211,238,.5)] bg-[rgba(34,211,238,.08)] px-3 py-2 text-[12.5px] tracking-[.4px] text-nb-tealb transition hover:shadow-[0_0_10px_rgba(34,211,238,.25)] disabled:opacity-50"
        >
          {save.isPending ? "Saving…" : "Save changes"}
        </button>
      </div>

      {cfg.isLoading ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : (
        <div className="space-y-6 max-w-2xl">
          {groups.map((group) => (
            <Card key={group} className="p-5 !border-nb-line !bg-[rgba(8,15,34,.5)]">
              <h2 className="text-sm font-semibold text-nb-ink mb-1">{group}</h2>
              <div>
                {catalog
                  .filter((c) => c.group === group)
                  .map((item) => (
                    <SettingField
                      key={item.key}
                      item={item}
                      value={values[item.key]}
                      onChange={(v) => setValues((prev) => ({ ...prev, [item.key]: v }))}
                    />
                  ))}
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
