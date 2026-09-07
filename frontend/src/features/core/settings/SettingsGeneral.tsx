"use client";

// System settings — platform-wide options, driven by a server-provided catalog.
// Thin orchestrator: owns the config query, the local values buffer and the save
// mutation; delegates each control to SettingField.
//
// LAYOUT — a bento sized by FIELD COUNT, not by group name. The previous version
// hardcoded `WIDE = "Google Maps"` and gave that group the entire lower half of
// the screen: five fields for a provider that is OFF by default and now largely
// superseded by the offline basemap and the self-hosted geocoder. The most screen
// went to the least relevant thing, and only because its name was in the code.
//
// A group with four or more fields earns the wide cell and lays its fields out in
// two columns; everything else takes a small one. Add a setting to the catalog and
// the layout follows, with no name to remember here.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Icon } from "@iconify/react";

import { ActionButton } from "@/components/console";
import { Spinner } from "@/components/ui/kit";
import { api, apiError } from "@/lib/api";
import type { SettingCatalogItem, SettingValue, SettingsOut } from "../types";
import SettingField from "./components/SettingField";

export default function SettingsGeneralPage() {
  const qc = useQueryClient();
  const cfg = useQuery({
    queryKey: ["settings-config"],
    queryFn: () => api.get<SettingsOut>("/settings").then((r) => r.data),
  });

  const [values, setValues] = useState<Record<string, SettingValue>>({});
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

  const catalog: SettingCatalogItem[] = cfg.data?.catalog || [];
  const groups = [...new Set(catalog.map((c) => c.group))];
  const fieldsOf = (group: string) => catalog.filter((c) => c.group === group);
  /** Four or more fields is a section; fewer is a switch or a line of text. */
  const WIDE_AT = 4;

  const renderField = (item: SettingCatalogItem) => (
    <SettingField
      key={item.key}
      item={item}
      value={values[item.key]}
      onChange={(v) => setValues((prev) => ({ ...prev, [item.key]: v }))}
    />
  );
  const headCls =
    "mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[1.3px] text-nb-muted";

  return (
    <section className="shrink-0">
      <div className="mb-2 flex shrink-0 items-center gap-2">
        <Icon icon="heroicons-outline:adjustments-horizontal" className="text-sm text-nb-blueb" />
        <h2 className="text-[11px] font-semibold uppercase tracking-[1.6px] text-nb-muted">Settings</h2>
        <span className="text-[11px] text-nb-faint">edited here</span>
        <span className="ml-auto">
          <ActionButton
            icon="heroicons-outline:check"
            disabled={save.isPending || cfg.isLoading}
            onClick={() => save.mutate()}
          >
            {save.isPending ? "Saving…" : "Save changes"}
          </ActionButton>
        </span>
      </div>

      {cfg.isLoading ? (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      ) : (
        // Same six columns as the posture band above, so the two line up, and
        // the same `auto-rows-fr` so this band fits its share of the pane.
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-6">
          {groups.map((group) => {
            const fields = fieldsOf(group);
            const wide = fields.length >= WIDE_AT;
            return (
              <div
                key={group}
                className={`rounded-[12px] border border-nb-line bg-[rgba(8,15,34,.5)] p-4 ${
                  wide ? "md:col-span-2 lg:col-span-6" : "lg:col-span-2"
                }`}
              >
                <h3 className={headCls}>{group}</h3>
                <div className={wide ? "grid grid-cols-1 gap-x-8 md:grid-cols-2 xl:grid-cols-3" : undefined}>
                  {fields.map(renderField)}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
