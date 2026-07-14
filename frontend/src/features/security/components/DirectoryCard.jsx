"use client";

// LDAP / Active Directory integration (P6-D). Bind to a corporate directory, map
// groups → roles, and sync users. GET/PUT/DELETE /security/directory +
// POST /security/directory/sync. bind_password is write-only.
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { Button, Input, Toggle } from "@/components/ui/kit";
import { apiError } from "@/lib/api";
import { security } from "../api";
import SecuritySection from "./SecuritySection";
import RoleMapEditor from "./RoleMapEditor";

const PLACEHOLDER = "•••••••• (unchanged)";

const EMPTY = {
  name: "Directory",
  enabled: true,
  server_uri: "",
  base_dn: "",
  bind_dn: "",
  use_ssl: true,
  user_dn_base: "",
  user_filter: "(sAMAccountName={username})",
  email_attr: "mail",
  name_attr: "displayName",
  group_attr: "memberOf",
  default_role: "",
};

export default function DirectoryCard({ canManage }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["security-directory"], queryFn: () => security.directory.get() });

  const [form, setForm] = useState(EMPTY);
  const [password, setPassword] = useState("");
  const [groupRoleMap, setGroupRoleMap] = useState({});
  const [hasBindPassword, setHasBindPassword] = useState(false);
  const configured = !!q.data;

  useEffect(() => {
    const c = q.data;
    if (!c) {
      setForm(EMPTY);
      setGroupRoleMap({});
      setHasBindPassword(false);
      return;
    }
    setForm({
      name: c.name || "Directory",
      enabled: c.enabled,
      server_uri: c.server_uri || "",
      base_dn: c.base_dn || "",
      bind_dn: c.bind_dn || "",
      use_ssl: c.use_ssl,
      user_dn_base: c.user_dn_base || "",
      user_filter: c.user_filter || EMPTY.user_filter,
      email_attr: c.email_attr || "mail",
      name_attr: c.name_attr || "displayName",
      group_attr: c.group_attr || "memberOf",
      default_role: c.default_role || "",
    });
    setGroupRoleMap(c.group_role_map || {});
    setHasBindPassword(c.has_bind_password);
    setPassword("");
  }, [q.data]);

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  const save = useMutation({
    mutationFn: () => {
      const body = {
        ...form,
        default_role: form.default_role || null,
        user_dn_base: form.user_dn_base || null,
        group_role_map: groupRoleMap,
      };
      if (password) body.bind_password = password;
      return security.directory.upsert(body);
    },
    onSuccess: () => {
      toast.success("Directory saved");
      setPassword("");
      qc.invalidateQueries({ queryKey: ["security-directory"] });
    },
    onError: (e) => toast.error(apiError(e, "Save failed")),
  });

  const remove = useMutation({
    mutationFn: () => security.directory.remove(),
    onSuccess: () => {
      toast.success("Directory removed");
      qc.invalidateQueries({ queryKey: ["security-directory"] });
    },
    onError: (e) => toast.error(apiError(e, "Delete failed")),
  });

  const sync = useMutation({
    mutationFn: () => security.directory.sync(),
    onSuccess: (res) => {
      const msg = `Sync ${res.live ? "(live)" : "(scaffold)"}: +${res.created} created, ${res.updated} updated, ${res.skipped} skipped`;
      if (res.errors?.length) toast.warning(`${msg}, ${res.errors.length} error(s)`);
      else toast.success(msg);
      qc.invalidateQueries({ queryKey: ["security-directory"] });
    },
    onError: (e) => toast.error(apiError(e, "Sync failed")),
  });

  return (
    <SecuritySection
      title="LDAP / Active Directory"
      desc="Authenticate against a corporate directory and map directory groups to roles. Users can sign in with their AD credentials."
      icon="heroicons-outline:building-office-2"
      loading={q.isLoading}
      error={q.isError ? apiError(q.error, "Failed to load directory") : null}
      action={
        canManage && (
          <div className="flex items-center gap-2">
            {configured && (
              <Button
                variant="secondary"
                icon="heroicons-outline:arrow-path"
                disabled={sync.isPending}
                onClick={() => sync.mutate()}
              >
                {sync.isPending ? "Syncing…" : "Sync"}
              </Button>
            )}
            <Button variant="primary" icon="heroicons-outline:check" disabled={save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? "Saving…" : "Save"}
            </Button>
          </div>
        )
      }
    >
      <div className="space-y-4">
        <label className="flex items-center justify-between rounded-lg border border-card-border bg-hover/30 px-3 py-2.5">
          <span className="text-sm text-foreground">Directory enabled</span>
          <Toggle checked={form.enabled} onChange={(v) => set({ enabled: v })} disabled={!canManage} />
        </label>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Input label="Display name" value={form.name} onChange={(e) => set({ name: e.target.value })} disabled={!canManage} />
          <Input
            label="Server URI"
            value={form.server_uri}
            onChange={(e) => set({ server_uri: e.target.value })}
            disabled={!canManage}
            placeholder="ldaps://ad.example.com:636"
          />
          <Input label="Base DN" value={form.base_dn} onChange={(e) => set({ base_dn: e.target.value })} disabled={!canManage} placeholder="dc=example,dc=com" />
          <Input label="Bind DN" value={form.bind_dn} onChange={(e) => set({ bind_dn: e.target.value })} disabled={!canManage} placeholder="cn=svc,dc=example,dc=com" />
          <Input
            label="Bind password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={!canManage}
            placeholder={hasBindPassword ? PLACEHOLDER : "Set the bind password"}
            autoComplete="new-password"
          />
          <label className="flex items-center justify-between rounded-lg border border-card-border bg-hover/30 px-3 py-2.5">
            <span className="text-sm text-foreground">Use SSL/TLS</span>
            <Toggle checked={form.use_ssl} onChange={(v) => set({ use_ssl: v })} disabled={!canManage} />
          </label>
        </div>

        <details className="rounded-lg border border-card-border">
          <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted">
            Attribute mapping
          </summary>
          <div className="grid grid-cols-1 gap-3 border-t border-card-border p-3 sm:grid-cols-2">
            <Input label="User DN base (optional)" value={form.user_dn_base} onChange={(e) => set({ user_dn_base: e.target.value })} disabled={!canManage} placeholder="ou=Users,dc=example,dc=com" />
            <Input label="User filter" value={form.user_filter} onChange={(e) => set({ user_filter: e.target.value })} disabled={!canManage} />
            <Input label="Email attribute" value={form.email_attr} onChange={(e) => set({ email_attr: e.target.value })} disabled={!canManage} />
            <Input label="Name attribute" value={form.name_attr} onChange={(e) => set({ name_attr: e.target.value })} disabled={!canManage} />
            <Input label="Group attribute" value={form.group_attr} onChange={(e) => set({ group_attr: e.target.value })} disabled={!canManage} />
            <Input label="Default role (optional)" value={form.default_role} onChange={(e) => set({ default_role: e.target.value })} disabled={!canManage} placeholder="viewer" />
          </div>
        </details>

        <RoleMapEditor
          label="Group → role mapping"
          keyLabel="Directory group"
          value={groupRoleMap}
          onChange={setGroupRoleMap}
          disabled={!canManage}
        />

        {configured && canManage && (
          <div className="flex items-center gap-2 border-t border-card-border pt-3">
            <Icon icon="heroicons-outline:exclamation-triangle" className="text-sm text-red-500" />
            <button
              className="text-xs text-red-500 transition hover:underline"
              onClick={() => {
                if (window.confirm("Remove the directory configuration?")) remove.mutate();
              }}
            >
              Remove directory configuration
            </button>
          </div>
        )}

        <p className="flex items-start gap-2 text-[11px] text-muted">
          <Icon icon="heroicons-outline:information-circle" className="mt-0.5 shrink-0" />
          Live LDAP bind requires the server to have the ldap3 extra installed and reachable directory. Sync reports
          <span className="mx-1 rounded bg-hover px-1">live: true</span> when a real bind was used.
        </p>
      </div>
    </SecuritySection>
  );
}
