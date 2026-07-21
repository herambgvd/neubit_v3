"use client";

// General settings — platform-wide options grouped into cards, driven by a
// server-provided catalog. Thin orchestrator: owns the config query, the local
// values buffer, and the save mutation; delegates each control to SettingField.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button, Card, Spinner } from "@/components/ui/kit";
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
    <div>
      {cfg.isLoading ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {groups.map((group) => (
              <Card key={group} className="p-5">
                <h2 className="text-sm font-semibold text-foreground mb-1">{group}</h2>
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

          <div className="mt-6 flex items-center justify-end">
            <Button variant="primary" disabled={save.isPending || cfg.isLoading} onClick={() => save.mutate()}>
              {save.isPending ? "Saving…" : "Save changes"}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
