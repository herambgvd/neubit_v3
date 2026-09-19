"use client";

// A new system on the site. The kind is chosen once, here, from the server's
// vocabulary: every piece of equipment is later admitted against it, so the
// server will not let it change afterwards.
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { ActionButton, QuietButton } from "@/components/console";
import { Input, Select } from "@/components/ui/kit";
import { apiError } from "@/lib/api";
import { siteInfrastructure } from "@/lib/api/siteInfrastructure";
import type { InfraVocabulary, SiteSystemPublic } from "@/lib/types";

export interface NewSystemFormProps {
  siteId: string;
  vocab: InfraVocabulary;
  onCreated: (s: SiteSystemPublic) => void;
  onCancel: () => void;
}

export default function NewSystemForm({ siteId, vocab, onCreated, onCancel }: Readonly<NewSystemFormProps>) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [kind, setKind] = useState("");
  const [description, setDescription] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      siteInfrastructure.createSystem(siteId, {
        name: name.trim(),
        kind,
        description: description.trim() || null,
      }),
    onSuccess: (s) => {
      qc.invalidateQueries({ queryKey: ["infra-tree", siteId] });
      onCreated(s);
    },
    // A 409 names the duplicate; shown as the server wrote it.
    onError: (e) => setErr(apiError(e, "Could not create the system")),
  });

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate();
      }}
    >
      <h3 className="text-[15px] font-semibold text-nb-ink">New system</h3>
      <div className="grid gap-2 md:grid-cols-2">
        <Input label="System name" required value={name} onChange={(e) => setName(e.target.value)} placeholder="Plant A" />
        <Select
          label="Kind"
          value={kind}
          placeholder="Pick a kind"
          onChange={(e) => setKind(e.target.value)}
          options={vocab.system_kinds.map((k) => ({ value: k.key, label: k.label }))}
        />
      </div>
      {kind && (
        <p className="text-[11px] text-nb-faint">{vocab.system_kinds.find((k) => k.key === kind)?.description}</p>
      )}
      <Input label="Description" value={description} onChange={(e) => setDescription(e.target.value)} />
      {err && (
        <p role="alert" className="text-[11.5px] text-nb-crit">
          {err}
        </p>
      )}
      <div className="flex items-center gap-2">
        <ActionButton type="submit" disabled={create.isPending || !name.trim() || !kind}>
          {create.isPending ? "Creating…" : "Create system"}
        </ActionButton>
        <QuietButton type="button" onClick={onCancel}>
          Cancel
        </QuietButton>
      </div>
    </form>
  );
}
