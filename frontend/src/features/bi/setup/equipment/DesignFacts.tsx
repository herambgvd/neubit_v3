"use client";

// The nameplate: the design facts the equipment's CLASS allows, each with the
// unit it is stored in. A fact never recorded prints as "not recorded" — a
// chiller with no TR on file is not a zero-ton chiller.
//
// THE PUT REPLACES THE WHOLE SET. So the form never sends what the operator
// typed on its own: `buildDesign` lays only the CHANGED fields over the facts
// recorded now, and a save that would clear a recorded fact stops and names it
// before anything is written.
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { ActionButton, QuietButton, RowAction } from "@/components/console";
import { ConfirmDialog, Input, type ConfirmState } from "@/components/ui/kit";
import { apiError } from "@/lib/api";
import { siteInfrastructure } from "@/lib/api/siteInfrastructure";
import type { EquipmentPublic, InfraDesignFactDef, InfraDesignValue } from "@/lib/types";

import { buildDesign, draftFrom, factText } from "./vocabulary";

export interface DesignFactsProps {
  equipment: EquipmentPublic;
  facts: InfraDesignFactDef[];
  mayWrite: boolean;
}

export default function DesignFacts({ equipment, facts, mayWrite }: Readonly<DesignFactsProps>) {
  const qc = useQueryClient();
  const [initial, setInitial] = useState<Record<string, string> | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const editing = initial !== null;

  const save = useMutation({
    mutationFn: (design: Record<string, InfraDesignValue | null>) =>
      siteInfrastructure.setDesign(equipment.site_id, equipment.equipment_id, { design }),
    onSuccess: () => {
      setConfirm(null);
      setInitial(null);
      setServerError(null);
      qc.invalidateQueries({ queryKey: ["infra-tree", equipment.site_id] });
    },
    onError: (e) => {
      setConfirm(null);
      setServerError(apiError(e, "Could not save the design facts"));
    },
  });

  if (!facts.length) return <p className="text-[11.5px] text-nb-faint">This class carries no design facts.</p>;

  const label = (key: string) => facts.find((f) => f.key === key)?.label ?? key;

  const submit = () => {
    if (!initial) return;
    if (facts.every((f) => (draft[f.key] ?? "").trim() === (initial[f.key] ?? "").trim())) {
      setInitial(null); // nothing changed: nothing to write
      return;
    }
    // `equipment.design` is what the server holds NOW — the tree refetches under
    // an open form — so an untouched fact is sent as it is recorded, not as it
    // was when the form opened.
    const built = buildDesign(equipment.design, initial, draft, facts);
    setErrors(built.errors);
    if (Object.keys(built.errors).length) return;
    if (built.cleared.length) {
      setConfirm({
        title: "Clear recorded facts?",
        message: `Saving clears ${built.cleared.map(label).join(", ")}. The other facts are kept.`,
        confirmLabel: "Clear and save",
        onConfirm: () => save.mutate(built.design),
      });
      return;
    }
    save.mutate(built.design);
  };

  return (
    <div>
      {editing ? (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="grid gap-2 md:grid-cols-2">
            {facts.map((f) => (
              <div key={f.key} className="flex items-end gap-2">
                <Input
                  wrapperClassName="block flex-1"
                  label={f.label}
                  value={draft[f.key] ?? ""}
                  inputMode={f.type === "number" ? "decimal" : undefined}
                  onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                  error={errors[f.key]}
                />
                {f.unit && <span className="pb-2.5 font-mono text-[11px] text-nb-soft">{f.unit}</span>}
              </div>
            ))}
          </div>
          {serverError && (
            <p role="alert" className="text-[11.5px] text-nb-crit">
              {serverError}
            </p>
          )}
          <div className="flex items-center gap-2">
            <ActionButton type="submit" disabled={save.isPending}>
              {save.isPending ? "Saving…" : "Save facts"}
            </ActionButton>
            <QuietButton
              type="button"
              onClick={() => {
                setInitial(null);
                setErrors({});
                setServerError(null);
              }}
            >
              Cancel
            </QuietButton>
          </div>
        </form>
      ) : (
        <div className="flex items-start gap-2">
          <dl className="grid flex-1 grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 rounded-[10px] border border-nb-line bg-[rgba(8,15,34,.5)] px-3 py-2">
            {facts.map((f) => {
              const v = factText(equipment.design[f.key]);
              return (
                <div key={f.key} className="contents" data-testid={`fact-${f.key}`}>
                  <dt className="text-[12px] text-nb-soft">{f.label}</dt>
                  <dd className="text-right text-[12px]">
                    {v === null ? (
                      <span className="italic text-nb-faint">not recorded</span>
                    ) : (
                      <span className="font-mono text-nb-ink">
                        {v}
                        {f.unit && <span className="ml-1 text-nb-soft">{equipment.design_units[f.key] ?? f.unit}</span>}
                      </span>
                    )}
                  </dd>
                </div>
              );
            })}
          </dl>
          {mayWrite && (
            <RowAction
              icon="heroicons-outline:pencil-square"
              title="Edit design facts"
              onClick={() => {
                const start = draftFrom(equipment.design, facts);
                setInitial(start);
                setDraft(start);
                setErrors({});
                setServerError(null);
              }}
            />
          )}
        </div>
      )}
      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} pending={save.isPending} />
    </div>
  );
}
