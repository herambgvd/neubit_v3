"use client";

// API Keys — table of programmatic access tokens with create + revoke. The raw
// secret is shown once on creation. Thin orchestrator: owns queries, mutations,
// and dialog state; delegates the table columns and modals to components.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { ActionButton } from "@/components/console";
import { Card, ConfirmDialog, Spinner, Table, type ConfirmState } from "@/components/ui/kit";
import { api, apiError } from "@/lib/api";
import type { Page } from "@/lib/types";
import type { ApiKeyCreatedOut, ApiKeyOut, RoleOut } from "../types";
import { buildApiKeyColumns } from "./components/ApiKeyColumns";
import CreateApiKeyModal, { type ApiKeyForm } from "./components/CreateApiKeyModal";
import RevealKeyModal from "./components/RevealKeyModal";

const EMPTY: ApiKeyForm = { name: "", role_id: "" };

export default function ApiKeysPage() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [revealed, setRevealed] = useState<ApiKeyCreatedOut | null>(null); // the newly-created key object with raw `key`
  const [copied, setCopied] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);

  const keys = useQuery({
    queryKey: ["api-keys"],
    queryFn: () => api.get<Page<ApiKeyOut>>("/auth/api-keys", { params: { page_size: 100 } }).then((r) => r.data),
  });
  const roles = useQuery({
    queryKey: ["roles"],
    queryFn: () => api.get<Page<RoleOut>>("/auth/roles", { params: { page_size: 100 } }).then((r) => r.data),
  });
  const roleOptions = (roles.data?.items || []).map((r) => ({ value: r.id, label: r.name }));

  const create = useMutation({
    mutationFn: (body: ApiKeyForm) => api.post<ApiKeyCreatedOut>("/auth/api-keys", body).then((r) => r.data),
    onSuccess: (data) => {
      toast.success("API key created");
      qc.invalidateQueries({ queryKey: ["api-keys"] });
      setOpen(false);
      setForm(EMPTY);
      setRevealed(data);
      setCopied(false);
    },
    onError: (e) => toast.error(apiError(e)),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.delete(`/auth/api-keys/${id}`),
    onSuccess: () => {
      toast.success("API key revoked");
      qc.invalidateQueries({ queryKey: ["api-keys"] });
      setConfirm(null);
    },
    onError: (e) => toast.error(apiError(e)),
  });

  function handleRevoke(row: ApiKeyOut) {
    setConfirm({
      title: "Revoke API key",
      message: <>Revoke <strong>{row.name}</strong>? Applications using it will stop working.</>,
      confirmLabel: "Revoke key",
      onConfirm: () => revoke.mutate(row.id),
    });
  }

  async function copyKey() {
    if (!revealed) return; // the Copy button only exists inside the reveal dialog
    try {
      await navigator.clipboard.writeText(revealed.key);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Could not copy to clipboard");
    }
  }

  const columns = buildApiKeyColumns({ onRevoke: handleRevoke });

  return (
    <div>
      <div className="mb-3 flex items-center justify-end">
        <ActionButton icon="heroicons-outline:plus" onClick={() => setOpen(true)}>Create key</ActionButton>
      </div>
      <Card className="p-2">
        {keys.isLoading ? (
          <div className="flex justify-center py-16">
            <Spinner />
          </div>
        ) : (
          <Table columns={columns} rows={keys.data?.items} />
        )}
      </Card>

      <CreateApiKeyModal
        open={open}
        onClose={() => setOpen(false)}
        form={form}
        setForm={setForm}
        roleOptions={roleOptions}
        onCreate={() => create.mutate(form)}
        creating={create.isPending}
      />

      <RevealKeyModal
        revealed={revealed}
        onClose={() => setRevealed(null)}
        copied={copied}
        onCopy={copyKey}
      />

      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} pending={revoke.isPending} />
    </div>
  );
}
