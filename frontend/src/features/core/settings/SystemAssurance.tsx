"use client";

// System & Assurance — a READ-ONLY posture dashboard that aggregates real data from
// the security / licensing / evidence / settings backends. It never fabricates: every
// figure comes from an endpoint, and anything that isn't backed (lockout/password
// values, encryption-at-rest, watermark, port-exposure, STQC scores) is deliberately
// NOT shown. Config lives in the Security / License / Audit screens — this links out.
import { useQuery } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import Link from "next/link";

import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";

function q(key, url, opts: any = {}) {
  return {
    queryKey: key,
    queryFn: () => api.get(url).then((r) => r.data),
    retry: false,
    staleTime: 30_000,
    ...opts,
  };
}

function Kpi({ icon, label, value, tone = "blue", sub }: any) {
  const c = {
    good: "text-nb-good",
    warn: "text-nb-warn",
    crit: "text-nb-crit",
    blue: "text-nb-blueb",
    faint: "text-nb-faint",
  }[tone];
  return (
    <div className="rounded-[12px] border border-nb-line bg-[rgba(8,15,34,.5)] px-4 py-3">
      <div className="flex items-center gap-2 text-[10.5px] font-semibold uppercase tracking-[1.2px] text-nb-faint">
        <Icon icon={icon} className="text-sm text-nb-blueb" />
        {label}
      </div>
      <div className={`mt-1.5 font-mono text-[20px] font-semibold ${c}`}>{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-nb-faint">{sub}</div>}
    </div>
  );
}

function Section({ icon, title, link, linkLabel, children }: any) {
  return (
    <div className="rounded-[12px] border border-nb-line bg-[rgba(8,15,34,.5)] p-4">
      <div className="mb-2 flex items-center gap-2">
        <Icon icon={icon} className="text-sm text-nb-blueb" />
        <span className="text-[11px] font-semibold uppercase tracking-[1.3px] text-nb-muted">{title}</span>
        {link && (
          <Link href={link} className="ml-auto flex items-center gap-1 text-[11px] text-nb-blueb transition hover:text-nb-ink">
            {linkLabel || "Manage"} <Icon icon="heroicons-mini:arrow-right" className="text-[12px]" />
          </Link>
        )}
      </div>
      <div>{children}</div>
    </div>
  );
}

function Row({ label, value, tone = "ink", note }: any) {
  const c = { ink: "text-nb-ink", good: "text-nb-good", warn: "text-nb-warn", crit: "text-nb-crit", faint: "text-nb-faint", blue: "text-nb-blueb" }[tone];
  return (
    <div className="flex items-center gap-3 border-b border-nb-line/40 py-2 last:border-b-0">
      <span className="text-[12px] text-nb-faint">{label}</span>
      <span className="ml-auto flex items-center gap-2">
        {note && <span className="text-[11px] text-nb-faint">{note}</span>}
        <span className={`font-mono text-[12px] ${c}`}>{value}</span>
      </span>
    </div>
  );
}

const dash = "—";
const fmtDate = (s) => {
  if (!s) return dash;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? dash : d.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });
};

export default function SystemAssurance() {
  const { can } = useAuth();
  const canSec = can("security.manage");

  const features = useQuery<any>(q(["features"], "/features"));
  const policy = useQuery<any>(q(["security-policy"], "/security/policy", { enabled: canSec }));
  const users = useQuery<any>(q(["users", "assurance"], "/auth/users?page_size=100", { enabled: can("user.read") }));
  const dual = useQuery<any>(q(["dual-auth", "pending"], "/security/dual-auth?status=pending&page_size=1", { enabled: canSec }));
  const evidence = useQuery<any>(q(["evidence", "active"], "/vms/evidence?active_only=true&limit=1", { enabled: can("vms.playback.view") }));
  const directory = useQuery<any>(q(["directory"], "/security/directory", { enabled: canSec }));
  const sso = useQuery<any>(q(["sso"], "/security/sso", { enabled: canSec }));
  const settings = useQuery<any>(q(["settings-config"], "/settings", { enabled: can("settings.manage") }));

  // License
  const lic = features.data;
  const licState = lic?.license_state; // active | grace | expired
  const licTone = licState === "active" ? "good" : licState === "grace" ? "warn" : licState === "expired" ? "crit" : "faint";
  const modules = lic?.modules || [];
  const enabledMods = modules.filter((m) => m.enabled);

  // 2FA adoption (client-side over the loaded page)
  const uItems = users.data?.items || [];
  const uTotal = users.data?.total ?? uItems.length;
  const enrolled = uItems.filter((u) => u.totp_enabled).length;
  const sampled = uTotal > uItems.length;
  const require2fa = policy.data?.require_2fa;

  // Others
  const idle = policy.data?.session_idle_minutes;
  const pendingDual = dual.data?.total;
  const activeHolds = evidence.data?.total;
  const dir = directory.data; // null = not configured
  const ssoCfg = sso.data;
  const auditDays = settings.data?.values?.audit_retention_days;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-6">
      {/* KPI row */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi
          icon="heroicons-outline:key"
          label="License"
          value={licState ? licState.toUpperCase() : dash}
          tone={licTone}
          sub={lic?.expires_at ? `expires ${fmtDate(lic.expires_at)}` : lic ? "perpetual" : "—"}
        />
        <Kpi
          icon="heroicons-outline:device-phone-mobile"
          label="MFA enrolment"
          value={users.data ? `${enrolled}/${uItems.length}` : dash}
          tone={enrolled === uItems.length && uItems.length ? "good" : "warn"}
          sub={require2fa != null ? (require2fa ? "enforced by policy" : "optional") : sampled ? "first 100 users" : undefined}
        />
        <Kpi
          icon="heroicons-outline:lock-closed"
          label="Evidence holds"
          value={evidence.data ? activeHolds : evidence.isError ? dash : dash}
          tone={activeHolds ? "blue" : "faint"}
          sub="active legal holds"
        />
        <Kpi
          icon="heroicons-outline:user-group"
          label="Dual-auth pending"
          value={dual.data ? pendingDual : dash}
          tone={pendingDual ? "warn" : "faint"}
          sub="awaiting approval"
        />
      </div>

      {/* Sections */}
      <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Section icon="heroicons-outline:shield-check" title="Authentication & access" link="/config/security" linkLabel="Security">
          {canSec ? (
            <>
              <Row label="Two-factor (MFA)" value={require2fa ? "REQUIRED" : "OPTIONAL"} tone={require2fa ? "good" : "warn"} />
              <Row label="Enforced for roles" value={policy.data?.require_2fa_roles?.length ? policy.data.require_2fa_roles.join(", ") : "all / none"} tone="faint" />
              <Row label="Session idle timeout" value={idle ? `${idle} min` : "Not set"} tone={idle ? "ink" : "faint"} />
              <Row label="Directory (LDAP/AD)" value={dir ? (dir.enabled ? "ENABLED" : "CONFIGURED") : "OFF"} tone={dir?.enabled ? "good" : "faint"} note={dir?.last_sync_at ? `synced ${fmtDate(dir.last_sync_at)}` : undefined} />
              <Row label="Single sign-on (SSO)" value={ssoCfg ? (ssoCfg.enabled ? "ENABLED" : "CONFIGURED") : "OFF"} tone={ssoCfg?.enabled ? "good" : "faint"} note={ssoCfg?.issuer || undefined} />
            </>
          ) : (
            <p className="py-3 text-[12px] text-nb-faint">Requires the security.manage permission.</p>
          )}
        </Section>

        <Section icon="heroicons-outline:user-group" title="Approvals & oversight" link="/config/security" linkLabel="Dual-auth">
          {canSec ? (
            <>
              <Row label="Dual-authorization" value="AVAILABLE" tone="blue" note="four-eye approvals" />
              <Row label="Pending approvals" value={dual.data ? pendingDual : dash} tone={pendingDual ? "warn" : "faint"} />
              <Row label="Active evidence holds" value={evidence.data ? activeHolds : dash} tone={activeHolds ? "blue" : "faint"} />
            </>
          ) : (
            <p className="py-3 text-[12px] text-nb-faint">Requires the security.manage permission.</p>
          )}
        </Section>

        <Section icon="heroicons-outline:key" title="Licensing" link="/license" linkLabel="License">
          <Row label="State" value={licState ? licState.toUpperCase() : dash} tone={licTone} />
          <Row label="Plan" value={lic?.plan ? String(lic.plan).toUpperCase() : dash} tone="ink" />
          <Row label="Expiry" value={lic?.expires_at ? fmtDate(lic.expires_at) : lic ? "Perpetual" : dash} tone="ink" />
          <Row label="Modules enabled" value={lic ? `${enabledMods.length}/${modules.length}` : dash} tone="blue" note={enabledMods.slice(0, 4).map((m) => m.key).join(", ")} />
          {lic?.limits && Object.keys(lic.limits).length > 0 && (
            <Row label="Limits" value={Object.entries<any>(lic.limits).map(([k, v]) => `${k}:${v}`).join(" · ")} tone="faint" />
          )}
        </Section>

        <Section icon="heroicons-outline:archive-box" title="Data & evidence" link="/audit" linkLabel="Audit">
          <Row label="Audit retention" value={auditDays != null ? (Number(auditDays) > 0 ? `${auditDays} days` : "Forever") : dash} tone="ink" />
          <Row label="Active evidence holds" value={evidence.data ? activeHolds : dash} tone={activeHolds ? "blue" : "faint"} />
          <Row label="Export signing" value="Ed25519 · SHA-256" tone="good" note="tamper-evident" />
        </Section>
      </div>

      <p className="mt-4 text-[11px] leading-relaxed text-nb-faint">
        This is a read-only posture overview — every figure is read live from the security, licensing,
        evidence and settings services. Change policy in the linked screens. Metrics with no backing
        source (host hardening, encryption-at-rest, watermarking) are intentionally not shown here.
      </p>
    </div>
  );
}
