"use client";

// Assign-incident modal — a searchable user picker. Fetches core /auth/users,
// filters client-side on name/email, shows an Avatar + name + email per row, and
// on confirm calls wfApi.instances.assign(id, userId). Highlights the current
// assignee. The parent owns nothing here beyond open/close + the instance id.
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { Avatar, Button, Modal, Spinner } from "@/components/ui/kit";
import { api, apiError } from "@/lib/api";
import { asItems } from "@/lib/format";
import { workflow as wfApi } from "../../api";

const userName = (u) =>
  u?.full_name ||
  [u?.first_name, u?.last_name].filter(Boolean).join(" ").trim() ||
  u?.name ||
  u?.username ||
  u?.email ||
  String(u?.id || "").slice(0, 8);
const userId = (u) => u?.id ?? u?.user_id ?? u?._id;

export default function AssignModal({ open, onClose, instanceId, currentAssigneeId, onAssigned }) {
  const qc = useQueryClient();
  const [selected, setSelected] = useState(currentAssigneeId ?? "");
  const [search, setSearch] = useState("");

  // Lazy-fetch users only while the modal is open.
  const usersQ = useQuery({
    queryKey: ["auth-users-assign"],
    queryFn: () => api.get("/auth/users", { params: { page_size: 200 } }).then((r) => r.data),
    enabled: open,
    staleTime: 5 * 60 * 1000,
  });

  const users = useMemo(() => {
    const list = asItems(usersQ.data);
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter((u) => `${userName(u)} ${u.email || ""}`.toLowerCase().includes(q));
  }, [usersQ.data, search]);

  const mutation = useMutation({
    mutationFn: () => wfApi.instances.assign(instanceId, selected || null),
    onSuccess: () => {
      toast.success("Assignee updated");
      qc.invalidateQueries({ queryKey: ["wf-instance", instanceId] });
      onAssigned?.();
      handleClose();
    },
    onError: (e) => toast.error(apiError(e)),
  });

  function handleClose() {
    setSearch("");
    onClose?.();
  }

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Assign incident"
      footer={
        <>
          <Button variant="secondary" onClick={handleClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button onClick={() => mutation.mutate()} disabled={mutation.isPending}>
            {mutation.isPending ? "Assigning…" : "Assign"}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="relative">
          <Icon
            icon="heroicons-outline:magnifying-glass"
            className="absolute left-3 top-1/2 -translate-y-1/2 text-muted text-base"
          />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search users…"
            autoFocus
            className="h-10 w-full rounded-lg border border-field bg-transparent pl-9 pr-3 text-sm text-foreground placeholder:text-muted outline-none focus:border-muted"
          />
        </div>

        <div className="max-h-72 overflow-y-auto rounded-lg border border-card-border divide-y divide-card-border">
          {/* Unassign row */}
          <button
            type="button"
            onClick={() => setSelected("")}
            className={`flex w-full items-center gap-3 px-3 py-2.5 text-left transition ${
              !selected ? "bg-hover" : "hover:bg-hover"
            }`}
          >
            <div className="flex h-7 w-7 items-center justify-center rounded-full bg-hover border border-card-border text-muted shrink-0">
              <Icon icon="heroicons-outline:user-minus" className="text-sm" />
            </div>
            <span className="flex-1 text-sm text-foreground">Unassigned</span>
            {!selected && <Icon icon="heroicons-solid:check-circle" className="text-blue-500 text-lg shrink-0" />}
          </button>

          {usersQ.isLoading ? (
            <div className="flex items-center gap-2 px-3 py-4 text-sm text-muted">
              <Spinner className="!h-4 !w-4" /> Loading users…
            </div>
          ) : users.length === 0 ? (
            <div className="px-3 py-4 text-sm text-muted">No users found.</div>
          ) : (
            users.map((u) => {
              const uid = userId(u);
              const sel = String(uid) === String(selected);
              return (
                <button
                  key={uid}
                  type="button"
                  onClick={() => setSelected(uid)}
                  className={`flex w-full items-center gap-3 px-3 py-2.5 text-left transition ${
                    sel ? "bg-hover" : "hover:bg-hover"
                  }`}
                >
                  <Avatar name={userName(u)} src={u.avatar_url} size={28} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm font-medium text-foreground">
                      {userName(u)}
                      {String(uid) === String(currentAssigneeId) && (
                        <span className="ml-2 text-[10px] font-semibold uppercase tracking-wide text-blue-500">Current</span>
                      )}
                    </span>
                    {u.email && <span className="truncate text-xs text-muted">{u.email}</span>}
                  </span>
                  {sel && <Icon icon="heroicons-solid:check-circle" className="text-blue-500 text-lg shrink-0" />}
                </button>
              );
            })
          )}
        </div>
      </div>
    </Modal>
  );
}
