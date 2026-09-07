"use client";

// System & Assurance — a READ-ONLY posture dashboard that aggregates real data from
// the security / licensing / evidence / settings backends. It never fabricates: every
// figure comes from an endpoint, and anything that isn't backed (lockout/password
// values, encryption-at-rest, watermark, port-exposure, STQC scores) is deliberately
// NOT shown. Config lives in the Security / License / Audit screens — this links out.
//
// That "never fabricates" claim used to be false in two places: rows reading
// "Dual-authorization — AVAILABLE" and "Export signing — Ed25519 · SHA-256" were
// string constants, not measurements. They said a FEATURE EXISTS, which is a
// brochure line, and in a posture dashboard it is indistinguishable from a
// measured green. Both are gone.
//
// LAYOUT — four tiles on six columns, sized by weight:
//
//   NEEDS ATTENTION  what wants a human right now   (2 wide, 2 tall — the only
//                                                    actionable tile, so it leads)
//   ACCESS           who can get in                 (4 wide — five rows, the densest)
//   LICENSING        can we operate at all          (2 wide)
//   RETENTION        what we keep, for how long     (2 wide)
//
// SOURCE ORDER IS LOAD-BEARING. The hero spans two rows, so the tile after it
// must be 4 wide or row one ends with an empty pair of cells and everything else
// spills onto a third row. Reordering these four is a layout change.
//
// Each fact has ONE home. Active evidence holds used to appear three times on this
// page — as a KPI, under Approvals and again under Data — which is how a reader
// loses track of whether they are looking at one number or three.
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import Link from "next/link";

import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { Entitlements, Page } from "@/lib/types";
import type {
  DirectoryConfigOut,
  DualAuthRequestOut,
  SecurityPolicyOut,
  SettingsOut,
  SsoConfigOut,
  UserOut,
} from "../types";

// One read-only GET per posture figure. `T` names the response so each figure
// below is typed by the endpoint it comes from.
function q<T>(key: readonly unknown[], url: string, opts: { enabled?: boolean } = {}) {
  return {
    queryKey: key,
    queryFn: () => api.get<T>(url).then((r) => r.data),
    retry: false,
    staleTime: 30_000,
    ...opts,
  };
}

type KpiTone = "good" | "warn" | "crit" | "blue" | "faint";

const KPI_TONE: Record<KpiTone, string> = {
  good: "text-nb-good",
  warn: "text-nb-warn",
  crit: "text-nb-crit",
  blue: "text-nb-blueb",
  faint: "text-nb-faint",
};

/**
 * One bento cell. `span` is the only layout knob: the grid is six columns on
 * `lg`, and a tile says how much of it it deserves. Sizing by WEIGHT — how much
 * a reader has to do with what is inside — is the whole point of the arrangement;
 * a uniform grid gives the licence expiry and the audit-retention number equal
 * billing, and they are not equal.
 */
function Tile({
  icon,
  title,
  span = "lg:col-span-2",
  link,
  linkLabel,
  children,
}: {
  icon: string;
  title: ReactNode;
  span?: string;
  link?: string;
  linkLabel?: string;
  children?: ReactNode;
}) {
  return (
    <div
      className={`flex flex-col rounded-[12px] border border-nb-line bg-[rgba(8,15,34,.5)] p-4 ${span}`}
    >
      <div className="mb-2 flex items-center gap-2">
        <Icon icon={icon} className="text-sm text-nb-blueb" />
        <span className="text-[11px] font-semibold uppercase tracking-[1.3px] text-nb-muted">{title}</span>
        {link && (
          <Link href={link} className="ml-auto flex items-center gap-1 text-[11px] text-nb-blueb transition hover:text-nb-ink">
            {linkLabel || "Manage"} <Icon icon="heroicons-mini:arrow-right" className="text-[12px]" />
          </Link>
        )}
      </div>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}

/**
 * A number big enough to read across a room, with the place you go to act on it.
 * Only used in "Needs attention" — a figure nobody can act on does not get to be
 * this size.
 */
function Stat({
  label,
  value,
  tone = "faint",
  sub,
  href,
}: {
  label: ReactNode;
  value: ReactNode;
  tone?: KpiTone;
  sub?: ReactNode;
  href?: string;
}) {
  const body = (
    <>
      <div className="text-[10.5px] font-semibold uppercase tracking-[1.2px] text-nb-faint">{label}</div>
      <div className={`mt-0.5 font-mono text-[26px] font-semibold leading-none ${KPI_TONE[tone]}`}>{value}</div>
      {sub && <div className="mt-1 text-[11px] text-nb-faint">{sub}</div>}
    </>
  );
  const cls = "block rounded-[10px] border border-nb-line/60 bg-[rgba(6,11,26,.45)] px-3 py-2.5";
  return href ? (
    <Link href={href} className={`${cls} transition hover:border-nb-blue`}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

type RowTone = KpiTone | "ink";

const ROW_TONE: Record<RowTone, string> = { ink: "text-nb-ink", good: "text-nb-good", warn: "text-nb-warn", crit: "text-nb-crit", faint: "text-nb-faint", blue: "text-nb-blueb" };

function Row({ label, value, tone = "ink", note }: { label: ReactNode; value: ReactNode; tone?: RowTone; note?: ReactNode }) {
  const c = ROW_TONE[tone];
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
const fmtDate = (s: string | null | undefined): string => {
  if (!s) return dash;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? dash : d.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });
};

export default function SystemAssurance() {
  const { can } = useAuth();
  const canSec = can("security.manage");

  const features = useQuery(q<Entitlements>(["features"], "/features"));
  const policy = useQuery(q<SecurityPolicyOut>(["security-policy"], "/security/policy", { enabled: canSec }));
  const users = useQuery(q<Page<UserOut>>(["users", "assurance"], "/auth/users?page_size=100", { enabled: can("user.read") }));
  const dual = useQuery(q<Page<DualAuthRequestOut>>(["dual-auth", "pending"], "/security/dual-auth?status=pending&page_size=1", { enabled: canSec }));
  // `EvidenceLockListResponse` (vision) — only its `total` is read here.
  const evidence = useQuery(q<{ total: number }>(["evidence", "active"], "/vms/evidence?active_only=true&limit=1", { enabled: can("vms.playback.view") }));
  const directory = useQuery(q<DirectoryConfigOut | null>(["directory"], "/security/directory", { enabled: canSec }));
  const sso = useQuery(q<SsoConfigOut | null>(["sso"], "/security/sso", { enabled: canSec }));
  const settings = useQuery(q<SettingsOut>(["settings-config"], "/settings", { enabled: can("settings.manage") }));

  // License
  const lic = features.data;
  const licState = lic?.license_state; // active | grace | expired
  const licTone: KpiTone = licState === "active" ? "good" : licState === "grace" ? "warn" : licState === "expired" ? "crit" : "faint";
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

  // MFA adoption is counted over the FIRST PAGE of users, because that is all
  // this screen fetches. Say so whenever it is a sample: a bare "8/8" on a tenant
  // with 400 users reads as full coverage and is not.
  const mfaValue = users.data ? `${enrolled}/${uItems.length}` : dash;
  const mfaSub = !users.data
    ? undefined
    : sampled
      ? `sample — first ${uItems.length} of ${uTotal} users`
      : `${uTotal} user${uTotal === 1 ? "" : "s"}`;

  // "all / none" said nothing. Either a policy names roles, or it applies to
  // everyone, or there is no requirement to scope.
  const roleScope = !require2fa
    ? "Not required"
    : policy.data?.require_2fa_roles?.length
      ? policy.data.require_2fa_roles.join(", ")
      : "Everyone";

  return (
    <section className="shrink-0">
      <h2 className="mb-2 flex shrink-0 items-center gap-2 text-[11px] font-semibold uppercase tracking-[1.6px] text-nb-muted">
        <Icon icon="heroicons-outline:shield-check" className="text-sm text-nb-blueb" />
        Posture
        <span className="ml-1 font-normal normal-case tracking-normal text-nb-faint">read-only</span>
      </h2>
      {/* Six columns on lg. `auto-rows-fr` makes the rows share the height the
          band was given, so the grid FITS the pane instead of growing past it —
          the page itself must not scroll. A tile too dense for its cell scrolls
          inside itself (see Tile), which keeps the arrangement stable. */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-6">
        {/* ── what wants a human — the only actionable tile, so it leads ── */}
        <Tile
          icon="heroicons-outline:bell-alert"
          title="Needs attention"
          span="lg:col-span-2 lg:row-span-2"
        >
          <div className="grid gap-2">
            <Stat
              label="Pending approvals"
              value={dual.data ? pendingDual : dash}
              tone={pendingDual ? "warn" : "faint"}
              sub={canSec ? "dual-authorization queue" : "needs security.manage"}
              href={canSec ? "/config/security" : undefined}
            />
            <Stat
              label="Evidence holds"
              value={evidence.data ? activeHolds : dash}
              tone={activeHolds ? "blue" : "faint"}
              sub="active legal holds"
              href="/audit"
            />
            <Stat
              label="MFA enrolment"
              value={mfaValue}
              tone={users.data && enrolled === uItems.length && uItems.length ? "good" : "warn"}
              sub={mfaSub}
              href="/users"
            />
          </div>
        </Tile>

        {/* ── who can get in ── */}
        <Tile
          icon="heroicons-outline:shield-check"
          title="Access"
          span="lg:col-span-4"
          link="/config/security"
          linkLabel="Security"
        >
          {canSec ? (
            <>
              <Row label="Two-factor (MFA)" value={require2fa ? "REQUIRED" : "OPTIONAL"} tone={require2fa ? "good" : "warn"} />
              <Row label="Applies to" value={roleScope} tone="faint" />
              <Row label="Idle timeout" value={idle ? `${idle} min` : "Not set"} tone={idle ? "ink" : "faint"} />
              <Row
                label="Directory (LDAP/AD)"
                value={dir ? (dir.enabled ? "ENABLED" : "CONFIGURED") : "OFF"}
                tone={dir?.enabled ? "good" : "faint"}
                note={dir?.last_sync_at ? `synced ${fmtDate(dir.last_sync_at)}` : undefined}
              />
              <Row
                label="Single sign-on"
                value={ssoCfg ? (ssoCfg.enabled ? "ENABLED" : "CONFIGURED") : "OFF"}
                tone={ssoCfg?.enabled ? "good" : "faint"}
                note={ssoCfg?.issuer || undefined}
              />
            </>
          ) : (
            <p className="py-3 text-[12px] text-nb-faint">Requires the security.manage permission.</p>
          )}
        </Tile>

        {/* ── can we operate at all ── */}
        <Tile
          icon="heroicons-outline:key"
          title="Licensing"
          span="lg:col-span-2"
          link="/license"
          linkLabel="License"
        >
          <div className="mb-2 flex items-baseline gap-3">
            <span className={`font-mono text-[26px] font-semibold leading-none ${KPI_TONE[licTone]}`}>
              {licState ? licState.toUpperCase() : dash}
            </span>
            <span className="text-[11px] text-nb-faint">
              {lic?.expires_at ? `expires ${fmtDate(lic.expires_at)}` : lic ? "perpetual" : dash}
            </span>
          </div>
          <Row label="Plan" value={lic?.plan ? String(lic.plan).toUpperCase() : dash} tone="ink" />
          <Row
            label="Modules enabled"
            value={lic ? `${enabledMods.length}/${modules.length}` : dash}
            tone="blue"
            note={enabledMods.slice(0, 4).map((m) => m.key).join(", ")}
          />
          {lic?.limits && Object.keys(lic.limits).length > 0 && (
            <Row
              label="Limits"
              value={Object.entries(lic.limits).map(([k, v]) => `${k}:${v}`).join(" · ")}
              tone="faint"
            />
          )}
        </Tile>

        {/* ── what we keep ── */}
        <Tile
          icon="heroicons-outline:archive-box"
          title="Retention"
          span="lg:col-span-2"
          link="/audit"
          linkLabel="Audit"
        >
          <Row
            label="Audit log"
            value={auditDays != null ? (Number(auditDays) > 0 ? `${auditDays} days` : "Forever") : dash}
            tone="ink"
          />
          <Row
            label="Evidence under hold"
            value={evidence.data ? activeHolds : dash}
            tone={activeHolds ? "blue" : "faint"}
            note="exempt from purge"
          />
        </Tile>
      </div>

    </section>
  );
}
