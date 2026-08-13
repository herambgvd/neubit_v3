"use client";

// General settings — platform-wide options grouped into cards, driven by a
// server-provided catalog. Thin orchestrator: owns the config query, the local
// values buffer, and the save mutation; delegates each control to SettingField.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { ActionButton } from "@/components/console";
import { Spinner } from "@/components/ui/kit";
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
  // "Google Maps" carries the most fields → give it its own full-width row; the
  // other groups flow three-per-row above it (four of them since "Maps" was added,
  // so the last one wraps).
  const WIDE = "Google Maps";
  const topGroups = groups.filter((g) => g !== WIDE);
  const wideGroup = groups.includes(WIDE) ? WIDE : null;
  const fieldsOf = (group) => catalog.filter((c) => c.group === group);
  const renderField = (item) => (
    <SettingField
      key={item.key}
      item={item}
      value={values[item.key]}
      onChange={(v) => setValues((prev) => ({ ...prev, [item.key]: v }))}
    />
  );
  const cardCls = "rounded-[12px] border border-nb-line bg-[rgba(8,15,34,.5)] p-4";
  const headCls = "mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[1.3px] text-nb-muted";

  return (
    <div className="flex min-h-0 flex-1 flex-col px-1 text-nb-ink">
      <div className="mb-3 flex shrink-0 items-center justify-end">
        <ActionButton
          icon="heroicons-outline:check"
          disabled={save.isPending || cfg.isLoading}
          onClick={() => save.mutate()}
        >
          {save.isPending ? "Saving…" : "Save changes"}
        </ActionButton>
      </div>

      {cfg.isLoading ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : (
        // Fill the whole pane: top groups take the upper half, Google Maps the lower.
        <div className="flex min-h-0 flex-1 flex-col gap-3 pb-1">
          {/* top row — three groups across, stretched to fill */}
          <div className="grid flex-1 grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
            {topGroups.map((group) => (
              <div key={group} className={`${cardCls} min-h-0 overflow-y-auto`}>
                <h2 className={headCls}>{group}</h2>
                <div>{fieldsOf(group).map(renderField)}</div>
              </div>
            ))}
          </div>

          {/* wide row — Google Maps, fields laid out horizontally, stretched to fill */}
          {wideGroup && (
            <div className={`${cardCls} flex min-h-0 flex-1 flex-col overflow-y-auto`}>
              <h2 className={headCls}>{wideGroup}</h2>
              <div className="grid grid-cols-1 gap-x-8 md:grid-cols-2 xl:grid-cols-3">
                {fieldsOf(wideGroup).map(renderField)}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
