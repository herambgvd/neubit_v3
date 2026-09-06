/**
 * Contract: src/lib/types.ts vs the Pydantic models it mirrors.
 *
 * Every other test in this suite mocks `adminApi`, so all 172 of them would pass
 * if the backend renamed a field tomorrow — which is exactly the bug class the
 * TypeScript conversion found twice (`actor`, `pages`: fields the UI read that
 * the API never sent). This is the test that would have caught them.
 *
 * It reads the models from `backend/` at run time rather than from a generated
 * snapshot, so there is no regeneration step to forget. Its limit is honest and
 * worth stating: it proves the types agree with the models in THIS repo, not
 * with whatever a deployed core is actually serving.
 */
import path from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { readFileSync } from "node:fs";

import {
  parseAssignedDictKeys,
  parseModels,
  parseReturnedDictKeys,
  resolveFields,
  type ModelField,
} from "./pydantic";

const ROOT = path.resolve(__dirname, "../..", "..");
const CORE = path.join(ROOT, "backend/core/app");
const OPS_AGENT = path.join(ROOT, "backend/ops-agent/main.py");
const TYPES = path.resolve(__dirname, "../lib/types.ts");

interface TsProp {
  name: string;
  optional: boolean;
  type: string;
}

/** Members of every exported interface in types.ts. */
function readInterfaces(): Map<string, TsProp[]> {
  const source = ts.createSourceFile(
    TYPES,
    readFileSync(TYPES, "utf8"),
    ts.ScriptTarget.ES2022,
    true
  );
  const out = new Map<string, TsProp[]>();
  source.forEachChild((node) => {
    if (!ts.isInterfaceDeclaration(node)) return;
    const props: TsProp[] = [];
    for (const member of node.members) {
      if (!ts.isPropertySignature(member) || !member.name) continue;
      props.push({
        name: member.name.getText(source),
        optional: !!member.questionToken,
        type: member.type ? member.type.getText(source) : "unknown",
      });
    }
    out.set(node.name.text, props);
  });
  return out;
}

const interfaces = readInterfaces();

/** TS interface → the model it mirrors. */
const MAPPING: Record<string, { file: string; model: string }> = {
  Role: { file: "auth/schemas.py", model: "RoleOut" },
  User: { file: "auth/schemas.py", model: "UserOut" },
  LoginResult: { file: "auth/schemas.py", model: "LoginResult" },
  AccessOut: { file: "auth/schemas.py", model: "AccessOut" },
  TotpStatus: { file: "auth/schemas.py", model: "TotpStatusOut" },
  TotpSetup: { file: "auth/schemas.py", model: "TotpSetupOut" },
  RecoveryCodes: { file: "auth/schemas.py", model: "RecoveryCodesOut" },
  LoginSession: { file: "auth/schemas.py", model: "SessionOut" },
  Tenant: { file: "admin/schemas.py", model: "TenantWithCountOut" },
  TenantUsage: { file: "admin/schemas.py", model: "TenantUsageOut" },
  TenantAdmin: { file: "admin/schemas.py", model: "TenantAdminOut" },
  Impersonation: { file: "admin/schemas.py", model: "ImpersonateOut" },
  AdminUser: { file: "admin/schemas.py", model: "AdminUserOut" },
  AuditEntry: { file: "core/audit.py", model: "AuditLogOut" },
  PlatformModule: { file: "module_catalog/router.py", model: "ModuleOut" },
  PlatformSettings: { file: "settings/schemas.py", model: "SettingsOut" },
  Branding: { file: "branding/schemas.py", model: "BrandingOut" },
  Plan: { file: "billing/schemas.py", model: "PlanOut" },
  Subscription: { file: "billing/schemas.py", model: "SubscriptionOut" },
  Invoice: { file: "billing/schemas.py", model: "InvoiceOut" },
  BillingSummary: { file: "billing/schemas.py", model: "BillingSummaryOut" },
  Alert: { file: "alerts/schemas.py", model: "AlertOut" },
  AlertList: { file: "alerts/schemas.py", model: "AlertListOut" },
  Broadcast: { file: "broadcasts/schemas.py", model: "BroadcastOut" },
  ContainerLogs: { file: "../../ops-agent/main.py", model: "LogsOut" },
  OkResult: { file: "../../ops-agent/main.py", model: "OkOut" },
};

/**
 * Fields the backend sends that the panel deliberately does not model. Each needs
 * a reason: an empty entry here means "we mirror the model completely".
 */
const NOT_MODELLED: Record<string, Record<string, string>> = {
  // Paged<T> covers these; the envelope is generic on our side.
  Tenant: {},
  User: {},
};

function fieldsOf(entry: { file: string; model: string }): ModelField[] {
  const models = parseModels(path.join(CORE, entry.file));
  return resolveFields(models, entry.model);
}

describe("types.ts mirrors the backend models", () => {
  it("maps every wire interface to a model", () => {
    // Interfaces that are ours, not the backend's — they have no counterpart.
    const local = new Set([
      "ApiErrorBody",
      "Paged",
      "SettingCatalogEntry",
      "Container",
      "InfraHost",
      "DbImportResult",
    ]);
    const unmapped = [...interfaces.keys()].filter((n) => !MAPPING[n] && !local.has(n));

    expect(unmapped).toEqual([]);
  });

  // A parser that silently returned nothing would make every comparison below
  // pass. This is the guard against that.
  it("actually reads fields out of every mapped model", () => {
    const empty = Object.entries(MAPPING)
      .filter(([, entry]) => fieldsOf(entry).length === 0)
      .map(([tsName]) => tsName);

    expect(empty).toEqual([]);
  });

  it("reads the models in full, not just their first few lines", () => {
    // Spot-checked against the sources: a regression in the parser (a docstring
    // swallowing a body, say) shows up as a smaller count.
    const counts = {
      User: fieldsOf(MAPPING.User!).length,
      Tenant: fieldsOf(MAPPING.Tenant!).length,
      AuditEntry: fieldsOf(MAPPING.AuditEntry!).length,
      Invoice: fieldsOf(MAPPING.Invoice!).length,
    };

    expect(counts).toEqual({ User: 18, Tenant: 12, AuditEntry: 11, Invoice: 14 });
  });

  for (const [tsName, entry] of Object.entries(MAPPING)) {
    describe(`${tsName} ↔ ${entry.model}`, () => {
      it("declares no field the model does not have", () => {
        const modelNames = new Set(fieldsOf(entry).map((f) => f.name));
        const invented = (interfaces.get(tsName) ?? [])
          .map((p) => p.name)
          .filter((n) => !modelNames.has(n));

        // This is the `actor` / `pages` bug: a field the UI reads and the API
        // never sends, which renders as undefined and fails silently.
        expect(invented).toEqual([]);
      });

      it("declares every field the model always sends", () => {
        const props = new Set((interfaces.get(tsName) ?? []).map((p) => p.name));
        const allowed = NOT_MODELLED[tsName] ?? {};
        const missing = fieldsOf(entry)
          .filter((f) => f.required && !props.has(f.name) && !allowed[f.name])
          .map((f) => f.name);

        expect(missing).toEqual([]);
      });

      it("declares the model's optional fields too, or says why not", () => {
        const props = new Set((interfaces.get(tsName) ?? []).map((p) => p.name));
        const allowed = NOT_MODELLED[tsName] ?? {};
        const missing = fieldsOf(entry)
          .filter((f) => !f.required && !props.has(f.name) && !allowed[f.name])
          .map((f) => f.name);

        expect(missing).toEqual([]);
      });

      it("admits null wherever the model does", () => {
        const props = new Map((interfaces.get(tsName) ?? []).map((p) => [p.name, p]));
        const wrong = fieldsOf(entry)
          .filter((f) => f.nullable)
          .filter((f) => {
            const prop = props.get(f.name);
            if (!prop) return false; // covered by the tests above
            return !prop.optional && !/\bnull\b/.test(prop.type);
          })
          .map((f) => f.name);

        // A field typed `string` that arrives as null is how "—" turns into a
        // crash on `.slice()`.
        expect(wrong).toEqual([]);
      });
    });
  }
});

// The infrastructure payloads are hand-built dicts in ops-agent, not models.
describe("the infrastructure payloads match what ops-agent builds", () => {
  it("Container has exactly the keys _serialize returns", () => {
    const keys = parseReturnedDictKeys(OPS_AGENT, "def _serialize(").sort();
    const props = (interfaces.get("Container") ?? []).map((p) => p.name).sort();

    expect(props).toEqual(keys);
  });

  it("InfraHost covers every key host_summary can set", () => {
    const always = parseReturnedDictKeys(OPS_AGENT, "def host_summary(");
    const optional = parseAssignedDictKeys(OPS_AGENT, "def host_summary(", "out");
    const props = new Map((interfaces.get("InfraHost") ?? []).map((p) => [p.name, p]));

    expect([...always, ...optional].filter((k) => !props.has(k))).toEqual([]);
    // The psutil-derived keys are best-effort on the host, so they must be
    // optional here — reading them as required is how a missing psutil becomes
    // NaN on screen.
    expect(optional.filter((k) => !props.get(k)?.optional)).toEqual([]);
  });
});
