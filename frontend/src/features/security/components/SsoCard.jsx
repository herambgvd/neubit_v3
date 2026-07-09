"use client";

// OIDC single sign-on (P6-D). Configure an identity provider (Okta, Azure AD,
// Google, Keycloak, …) so users sign in via the IdP. GET/PUT/DELETE /security/sso.
// client_secret is write-only. Shows the login + callback (redirect) URLs the IdP
// app registration needs.
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
  provider: "oidc",
  enabled: true,
  issuer: "",
  client_id: "",
  scopes: "openid email profile",
  redirect_uri: "",
  email_claim: "email",
  name_claim: "name",
  groups_claim: "",
  default_role: "",
  auto_provision: true,
};

export default function SsoCard({ canManage }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["security-sso"], queryFn: () => security.sso.get() });

  const [form, setForm] = useState(EMPTY);
  const [secret, setSecret] = useState("");
  const [groupRoleMap, setGroupRoleMap] = useState({});
  const [hasSecret, setHasSecret] = useState(false);
  const configured = !!q.data;

  useEffect(() => {
    const c = q.data;
    if (!c) {
      setForm(EMPTY);
      setGroupRoleMap({});
      setHasSecret(false);
      return;
    }
    setForm({
      provider: c.provider || "oidc",
      enabled: c.enabled,
      issuer: c.issuer || "",
      client_id: c.client_id || "",
      scopes: c.scopes || EMPTY.scopes,
      redirect_uri: c.redirect_uri || "",
      email_claim: c.email_claim || "email",
      name_claim: c.name_claim || "name",
      groups_claim: c.groups_claim || "",
      default_role: c.default_role || "",
      auto_provision: c.auto_provision ?? true,
    });
    setGroupRoleMap(c.group_role_map || {});
    setHasSecret(c.has_client_secret);
    setSecret("");
  }, [q.data]);

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const loginUrl = `${origin}/api/v1/auth/sso/login`;
  const callbackUrl = form.redirect_uri || `${origin}/login/sso/callback`;

  const save = useMutation({
    mutationFn: () => {
      const body = {
        ...form,
        redirect_uri: form.redirect_uri || null,
        groups_claim: form.groups_claim || null,
        default_role: form.default_role || null,
        group_role_map: groupRoleMap,
      };
      if (secret) body.client_secret = secret;
      return security.sso.upsert(body);
    },
    onSuccess: () => {
      toast.success("SSO saved");
      setSecret("");
      qc.invalidateQueries({ queryKey: ["security-sso"] });
    },
    onError: (e) => toast.error(apiError(e, "Save failed")),
  });

  const remove = useMutation({
    mutationFn: () => security.sso.remove(),
    onSuccess: () => {
      toast.success("SSO removed");
      qc.invalidateQueries({ queryKey: ["security-sso"] });
    },
    onError: (e) => toast.error(apiError(e, "Delete failed")),
  });

  return (
    <SecuritySection
      title="Single sign-on (OIDC)"
      desc="Let users authenticate through your identity provider (Okta, Azure AD, Google, Keycloak). Users are provisioned + mapped to roles from their IdP claims."
      icon="heroicons-outline:key"
      loading={q.isLoading}
      error={q.isError ? apiError(q.error, "Failed to load SSO") : null}
      action={
        canManage && (
          <Button variant="primary" icon="heroicons-outline:check" disabled={save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        )
      }
    >
      <div className="space-y-4">
        <label className="flex items-center justify-between rounded-lg border border-card-border bg-hover/30 px-3 py-2.5">
          <span className="text-sm text-foreground">SSO enabled</span>
          <Toggle checked={form.enabled} onChange={(v) => set({ enabled: v })} disabled={!canManage} />
        </label>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Input label="Issuer URL" value={form.issuer} onChange={(e) => set({ issuer: e.target.value })} disabled={!canManage} placeholder="https://login.example.com" />
          <Input label="Client ID" value={form.client_id} onChange={(e) => set({ client_id: e.target.value })} disabled={!canManage} />
          <Input
            label="Client secret"
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            disabled={!canManage}
            placeholder={hasSecret ? PLACEHOLDER : "Set the client secret"}
            autoComplete="new-password"
          />
          <Input label="Scopes" value={form.scopes} onChange={(e) => set({ scopes: e.target.value })} disabled={!canManage} />
          <Input label="Redirect URI (optional)" value={form.redirect_uri} onChange={(e) => set({ redirect_uri: e.target.value })} disabled={!canManage} placeholder={callbackUrl} />
          <Input label="Default role (optional)" value={form.default_role} onChange={(e) => set({ default_role: e.target.value })} disabled={!canManage} placeholder="viewer" />
        </div>

        <details className="rounded-lg border border-card-border">
          <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted">
            Claim mapping
          </summary>
          <div className="grid grid-cols-1 gap-3 border-t border-card-border p-3 sm:grid-cols-3">
            <Input label="Email claim" value={form.email_claim} onChange={(e) => set({ email_claim: e.target.value })} disabled={!canManage} />
            <Input label="Name claim" value={form.name_claim} onChange={(e) => set({ name_claim: e.target.value })} disabled={!canManage} />
            <Input label="Groups claim" value={form.groups_claim} onChange={(e) => set({ groups_claim: e.target.value })} disabled={!canManage} placeholder="groups" />
          </div>
        </details>

        <RoleMapEditor
          label="Claim value → role mapping"
          keyLabel="Group / claim value"
          value={groupRoleMap}
          onChange={setGroupRoleMap}
          disabled={!canManage}
        />

        <label className="flex items-center justify-between rounded-lg border border-card-border bg-hover/30 px-3 py-2.5">
          <div>
            <span className="text-sm text-foreground">Auto-provision users</span>
            <p className="text-xs text-muted">Create a user on first successful SSO login.</p>
          </div>
          <Toggle checked={form.auto_provision} onChange={(v) => set({ auto_provision: v })} disabled={!canManage} />
        </label>

        {/* IdP app-registration hints */}
        <div className="rounded-lg border border-card-border bg-hover/30 p-3">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">Configure these in your IdP</p>
          <UrlRow label="Login URL" value={loginUrl} />
          <UrlRow label="Redirect / callback URL" value={callbackUrl} />
        </div>

        {configured && canManage && (
          <div className="flex items-center gap-2 border-t border-card-border pt-3">
            <Icon icon="heroicons-outline:exclamation-triangle" className="text-sm text-red-500" />
            <button
              className="text-xs text-red-500 transition hover:underline"
              onClick={() => {
                if (window.confirm("Remove the SSO configuration?")) remove.mutate();
              }}
            >
              Remove SSO configuration
            </button>
          </div>
        )}

        <p className="flex items-start gap-2 text-[11px] text-muted">
          <Icon icon="heroicons-outline:information-circle" className="mt-0.5 shrink-0" />
          The token-exchange callback is validated against a real IdP at login time. Discovery ({form.issuer || "issuer"}
          /.well-known/openid-configuration) must be reachable.
        </p>
      </div>
    </SecuritySection>
  );
}

function UrlRow({ label, value }) {
  const copy = () => {
    navigator.clipboard?.writeText(value);
    toast.success("Copied");
  };
  return (
    <div className="mt-1.5 flex items-center gap-3">
      <span className="w-44 shrink-0 text-xs text-muted">{label}</span>
      <code className="flex-1 truncate rounded-md border border-card-border bg-background/50 px-2.5 py-1.5 text-xs text-foreground">
        {value}
      </code>
      <button className="text-muted transition hover:text-foreground" title="Copy" onClick={copy}>
        <Icon icon="heroicons-outline:clipboard-document" className="text-base" />
      </button>
    </div>
  );
}
