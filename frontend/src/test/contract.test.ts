/**
 * Contract: the operator console's hand-written types vs the Pydantic models
 * they mirror.
 *
 * Every other test in this suite stubs the axios adapter or the api module, so
 * all of them would still pass if a backend field were renamed tomorrow. The
 * declarations in `src/lib/types.ts` and `src/features/*\/types.ts` are the ONLY
 * thing holding this console to the wire contract — and turning on `strict`
 * found eight fields the UI read or sent that the API does not have (a site
 * picker keyed on `id` instead of `site_id`, door lists keyed on a v2
 * `door_id`, a report column reading `actions` where the backend sends
 * `total_actions`). None of them threw. This is the test that fails instead.
 *
 * It READS the backend sources at run time rather than a generated snapshot:
 * both trees live in this repo, so drift fails the suite on the commit that
 * causes it, with no regeneration step to forget.
 *
 * The limit, stated honestly: it proves these types agree with the models IN
 * THIS REPO. It says nothing about what a deployed backend of another version
 * is actually serving.
 *
 * Four kinds of declaration, and every interface must be in exactly one:
 *   MAPPING     — mirrors a Pydantic model; compared field by field.
 *   DICTS       — mirrors a hand-built dict payload; compared against the
 *                 dict literal in the source.
 *   LOCAL       — ours, not the backend's (envelopes, form drafts, view
 *                 models, stream frames). Each carries a one-line reason.
 *   PASSTHROUGH — a wire shape with no machine-readable source in this repo
 *                 (proxied verbatim from a remote recorder, or shaped by a
 *                 third-party controller's DTO). Each carries a reason.
 */
import path from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import ts from "typescript";

import {
  parseDictKeys,
  parseFieldAliases,
  parseModels,
  resolveFields,
  type ModelField,
} from "./pydantic";

const ROOT = path.resolve(__dirname, "../..", "..");

/** The six backends this console spans. */
const SRC: Record<string, string> = {
  CORE: path.join(ROOT, "backend/core/app"),
  VISION: path.join(ROOT, "backend/vision/app/vms"),
  WORKFLOW: path.join(ROOT, "backend/workflow/app/workflow"),
  ACCESS: path.join(ROOT, "backend/access/app/access"),
  INGEST: path.join(ROOT, "backend/ingest/app/ingest"),
  RW: path.join(ROOT, "backend/reading-writer/app/api"),
};

const TS_FILES = [
  "lib/types.ts",
  "features/access/types.ts",
  "features/core/types.ts",
  "features/ingest/types.ts",
  "features/security/types.ts",
  "features/videowall/types.ts",
  "features/vms/types.ts",
  "features/workflow/types.ts",
];

interface TsProp {
  name: string;
  optional: boolean;
  type: string;
}

interface TsIface {
  props: TsProp[];
  /** Names in the `extends` clause, resolved against the same file then lib. */
  extends: string[];
  /** Keys an `Omit<…>` in the heritage clause takes away. */
  omits: Set<string>;
  file: string;
}

/** Every exported interface in the eight type files, keyed `<file>:<Name>`. */
function readInterfaces(): Map<string, TsIface> {
  const out = new Map<string, TsIface>();
  for (const rel of TS_FILES) {
    const file = path.resolve(__dirname, "..", rel);
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.ES2022,
      true
    );
    source.forEachChild((node) => {
      if (!ts.isInterfaceDeclaration(node)) return;
      const props: TsProp[] = [];
      for (const member of node.members) {
        if (!ts.isPropertySignature(member) || !member.name) continue;
        const name = member.name.getText(source);
        if (name.startsWith("[")) continue; // index signature, not a field
        props.push({
          name,
          optional: !!member.questionToken,
          type: member.type ? member.type.getText(source) : "unknown",
        });
      }
      const bases: string[] = [];
      const drops = new Set<string>();
      for (const clause of node.heritageClauses ?? []) {
        for (const t of clause.types) {
          // `X`, `Partial<X>`, `Partial<Omit<X, …>>` — take the innermost name.
          // `X`, `Partial<X>`, `Partial<Omit<X, "a" | "b">>` — peel the
          // wrappers off, remembering what an Omit takes away.
          let text = t.getText(source);
          const omitted = /Omit<[^,]+,([^>]*)>/.exec(text);
          for (const q of omitted?.[1]?.match(/"([^"]+)"/g) ?? []) drops.add(q.slice(1, -1));
          while (/^(Partial|Omit|Pick|Readonly|Required)</.test(text)) {
            text = text.slice(text.indexOf("<") + 1);
          }
          const m = /^[A-Za-z0-9_]+/.exec(text.trim());
          if (m) bases.push(m[0]);
        }
      }
      out.set(`${rel}:${node.name.text}`, { props, extends: bases, omits: drops, file: rel });
    });
  }
  return out;
}

const interfaces = readInterfaces();

/** An interface's own props plus everything it extends (nearest wins). */
function propsOf(key: string, seen = new Set<string>()): TsProp[] {
  if (seen.has(key)) return [];
  seen.add(key);
  const iface = interfaces.get(key);
  if (!iface) return [];
  const byName = new Map<string, TsProp>();
  for (const base of iface.extends) {
    const resolved = interfaces.has(`${iface.file}:${base}`)
      ? `${iface.file}:${base}`
      : `lib/types.ts:${base}`;
    for (const p of propsOf(resolved, seen)) {
      if (!iface.omits.has(p.name)) byName.set(p.name, p);
    }
  }
  for (const p of iface.props) byName.set(p.name, p);
  return [...byName.values()];
}

/** True when the interface (or anything it extends) has an index signature —
 *  such a type absorbs unknown keys by design, so "missing field" is moot. */
function hasIndexSignature(key: string): boolean {
  const iface = interfaces.get(key);
  if (!iface) return false;
  const file = path.resolve(__dirname, "..", iface.file);
  const text = readFileSync(file, "utf8");
  const name = key.split(":")[1]!;
  const decl = new RegExp(`interface ${name}\\b[^{]*\\{([\\s\\S]*?)\\n\\}`).exec(text);
  return !!decl && /\[\s*\w+\s*:\s*string\s*\]/.test(decl[1]!);
}

interface ModelEntry {
  src: keyof typeof SRC | string;
  file: string;
  model: string;
}

const MAPPING: Record<string, ModelEntry & { subset?: string }> = {
  /* --- lib/types.ts --- */
  "lib/types.ts:AccessDoorPublic": { src: "ACCESS", file: "schemas.py", model: "DoorPublic" },
  "lib/types.ts:AccessInstancePublic": { src: "ACCESS", file: "schemas.py", model: "InstancePublic" },
  "lib/types.ts:Address": { src: "CORE", file: "sites/site/schemas.py", model: "Address" },
  "lib/types.ts:AuthUser": { src: "CORE", file: "auth/schemas.py", model: "UserOut", subset: "the session user as this console reads them: only the claims the shell renders" },
  "lib/types.ts:BiDeviceListResponse": { src: "RW", file: "schemas.py", model: "DeviceListResponse" },
  "lib/types.ts:BiDeviceRow": { src: "RW", file: "schemas.py", model: "DeviceRow" },
  "lib/types.ts:BrandingOut": { src: "CORE", file: "branding/schemas.py", model: "BrandingOut" },
  "lib/types.ts:BuildingFactsUpdate": { src: "CORE", file: "sites/site/schemas.py", model: "BuildingFactsUpdate" },
  "lib/types.ts:CameraPublic": { src: "VISION", file: "cameras/schemas.py", model: "CameraPublic" },
  "lib/types.ts:Coordinates": { src: "CORE", file: "sites/site/schemas.py", model: "Coordinates" },
  "lib/types.ts:CreateFloorRequest": { src: "CORE", file: "sites/floor/schemas.py", model: "CreateFloorRequest" },
  "lib/types.ts:CreateSiteRequest": { src: "CORE", file: "sites/site/schemas.py", model: "CreateSiteRequest" },
  "lib/types.ts:CreateTagRequest": { src: "CORE", file: "tags/schemas.py", model: "CreateTagRequest" },
  "lib/types.ts:CreateZoneRequest": { src: "CORE", file: "sites/zone/schemas.py", model: "CreateZoneRequest" },
  "lib/types.ts:DevicePlacementListResponse": { src: "CORE", file: "sites/device/schemas.py", model: "DeviceListResponse" },
  "lib/types.ts:DevicePlacementPublic": { src: "CORE", file: "sites/device/schemas.py", model: "DevicePlacementPublic" },
  "lib/types.ts:EmissionFactorIn": { src: "CORE", file: "sites/site/schemas.py", model: "EmissionFactorIn" },
  "lib/types.ts:EmissionFactorListResponse": { src: "CORE", file: "sites/site/schemas.py", model: "EmissionFactorListResponse" },
  "lib/types.ts:EmissionFactorPublic": { src: "CORE", file: "sites/site/schemas.py", model: "EmissionFactorPublic" },
  "lib/types.ts:FloorPosition": { src: "CORE", file: "sites/device/schemas.py", model: "FloorPosition" },
  "lib/types.ts:FloorPublic": { src: "CORE", file: "sites/floor/schemas.py", model: "FloorPublic" },
  "lib/types.ts:LoginResponse": { src: "CORE", file: "auth/schemas.py", model: "LoginResult", subset: "the login screen reads only the token and the MFA challenge" },
  "lib/types.ts:NotificationOut": { src: "CORE", file: "messaging/router.py", model: "NotificationOut" },
  "lib/types.ts:OnvifPublic": { src: "VISION", file: "cameras/schemas.py", model: "OnvifPublic" },
  "lib/types.ts:Page": { src: "CORE", file: "core/pagination.py", model: "Page" },
  "lib/types.ts:RegisterDeviceRequest": { src: "CORE", file: "sites/device/schemas.py", model: "RegisterDeviceRequest" },
  "lib/types.ts:SitePublic": { src: "CORE", file: "sites/site/schemas.py", model: "SitePublic" },
  "lib/types.ts:TagAssignRequest": { src: "CORE", file: "tags/schemas.py", model: "TagAssignRequest" },
  "lib/types.ts:TagLinkPublic": { src: "CORE", file: "tags/schemas.py", model: "TagLinkPublic" },
  "lib/types.ts:TagPublic": { src: "CORE", file: "tags/schemas.py", model: "TagPublic" },
  "lib/types.ts:TariffSlabIn": { src: "CORE", file: "sites/site/schemas.py", model: "TariffSlabIn" },
  "lib/types.ts:TariffSlabListResponse": { src: "CORE", file: "sites/site/schemas.py", model: "TariffSlabListResponse" },
  "lib/types.ts:TariffSlabPublic": { src: "CORE", file: "sites/site/schemas.py", model: "TariffSlabPublic" },
  "lib/types.ts:ThreatLevelUpdate": { src: "CORE", file: "sites/site/schemas.py", model: "ThreatLevelUpdate" },
  "lib/types.ts:UpdateDeviceRequest": { src: "CORE", file: "sites/device/schemas.py", model: "UpdateDeviceRequest" },
  "lib/types.ts:UpdateFloorRequest": { src: "CORE", file: "sites/floor/schemas.py", model: "UpdateFloorRequest" },
  "lib/types.ts:UpdateSiteRequest": { src: "CORE", file: "sites/site/schemas.py", model: "UpdateSiteRequest" },
  "lib/types.ts:UpdateTagRequest": { src: "CORE", file: "tags/schemas.py", model: "UpdateTagRequest" },
  "lib/types.ts:UpdateZoneRequest": { src: "CORE", file: "sites/zone/schemas.py", model: "UpdateZoneRequest" },
  "lib/types.ts:ZonePublic": { src: "CORE", file: "sites/zone/schemas.py", model: "ZonePublic" },
  /* --- features/access/types.ts --- */
  "features/access/types.ts:AccessEventPublic": { src: "ACCESS", file: "schemas.py", model: "AccessEventPublic" },
  "features/access/types.ts:AccessGroupCreate": { src: "ACCESS", file: "schemas.py", model: "AccessGroupCreate" },
  "features/access/types.ts:AccessGroupListResponse": { src: "ACCESS", file: "schemas.py", model: "AccessGroupListResponse" },
  "features/access/types.ts:AccessGroupPublic": { src: "ACCESS", file: "schemas.py", model: "AccessGroupPublic" },
  "features/access/types.ts:AccessGroupUpdate": { src: "ACCESS", file: "schemas.py", model: "AccessGroupUpdate" },
  "features/access/types.ts:CardCreate": { src: "ACCESS", file: "schemas.py", model: "CardCreate" },
  "features/access/types.ts:CardUpdate": { src: "ACCESS", file: "schemas.py", model: "CardUpdate" },
  "features/access/types.ts:CardholderCreate": { src: "ACCESS", file: "schemas.py", model: "CardholderCreate" },
  "features/access/types.ts:CardholderUpdate": { src: "ACCESS", file: "schemas.py", model: "CardholderUpdate" },
  "features/access/types.ts:DoorUpdate": { src: "ACCESS", file: "schemas.py", model: "DoorUpdate" },
  "features/access/types.ts:InstanceCreate": { src: "ACCESS", file: "schemas.py", model: "InstanceCreate" },
  "features/access/types.ts:InstanceUpdate": { src: "ACCESS", file: "schemas.py", model: "InstanceUpdate" },
  "features/access/types.ts:MirrorRow": { src: "ACCESS", file: "schemas.py", model: "MirrorRow" },
  "features/access/types.ts:ScheduleCreate": { src: "ACCESS", file: "schemas.py", model: "ScheduleCreate" },
  "features/access/types.ts:ScheduleListResponse": { src: "ACCESS", file: "schemas.py", model: "ScheduleListResponse" },
  "features/access/types.ts:SchedulePublic": { src: "ACCESS", file: "schemas.py", model: "SchedulePublic" },
  "features/access/types.ts:ScheduleUpdate": { src: "ACCESS", file: "schemas.py", model: "ScheduleUpdate" },
  "features/access/types.ts:SyncJobListResponse": { src: "ACCESS", file: "schemas.py", model: "SyncJobListResponse" },
  "features/access/types.ts:SyncJobPublic": { src: "ACCESS", file: "schemas.py", model: "SyncJobPublic" },
  "features/access/types.ts:TestConnectionResponse": { src: "ACCESS", file: "schemas.py", model: "TestConnectionResponse" },
  "features/access/types.ts:TimeWindow": { src: "ACCESS", file: "schemas.py", model: "TimeWindow" },
  /* --- features/core/types.ts --- */
  "features/core/types.ts:ApiKeyCreatedOut": { src: "CORE", file: "auth/schemas.py", model: "ApiKeyCreatedOut" },
  "features/core/types.ts:ApiKeyOut": { src: "CORE", file: "auth/schemas.py", model: "ApiKeyOut" },
  "features/core/types.ts:AuditLogOut": { src: "CORE", file: "core/audit.py", model: "AuditLogOut" },
  "features/core/types.ts:AuditRetentionOut": { src: "CORE", file: "core/audit.py", model: "RetentionOut" },
  "features/core/types.ts:ChannelOut": { src: "CORE", file: "messaging/router.py", model: "ChannelOut" },
  "features/core/types.ts:CloneUserIn": { src: "CORE", file: "auth/schemas.py", model: "CloneUserIn" },
  "features/core/types.ts:CreateUserIn": { src: "CORE", file: "auth/schemas.py", model: "CreateUserIn" },
  "features/core/types.ts:DirectoryConfigOut": { src: "CORE", file: "security/schemas.py", model: "DirectoryConfigOut", subset: "the security-posture card names only the fields it renders; the rest ride the index signature" },
  "features/core/types.ts:DualAuthRequestOut": { src: "CORE", file: "security/schemas.py", model: "DualAuthRequestOut" },
  "features/core/types.ts:MapsConfigOut": { src: "CORE", file: "settings/schemas.py", model: "MapsConfigOut" },
  "features/core/types.ts:RecoveryCodesOut": { src: "CORE", file: "auth/schemas.py", model: "RecoveryCodesOut" },
  "features/core/types.ts:RoleBody": { src: "CORE", file: "auth/schemas.py", model: "CreateRoleIn" },
  "features/core/types.ts:RoleOut": { src: "CORE", file: "auth/schemas.py", model: "RoleOut" },
  "features/core/types.ts:SecurityPolicyOut": { src: "CORE", file: "security/schemas.py", model: "SecurityPolicyOut" },
  "features/core/types.ts:SessionOut": { src: "CORE", file: "auth/schemas.py", model: "SessionOut" },
  "features/core/types.ts:SettingsOut": { src: "CORE", file: "settings/schemas.py", model: "SettingsOut" },
  "features/core/types.ts:SsoConfigOut": { src: "CORE", file: "security/schemas.py", model: "SsoConfigOut", subset: "the security-posture card names only the fields it renders; the rest ride the index signature" },
  "features/core/types.ts:TemplateOut": { src: "CORE", file: "messaging/router.py", model: "TemplateOut" },
  "features/core/types.ts:TemplateSummaryOut": { src: "CORE", file: "messaging/router.py", model: "TemplateSummaryOut" },
  "features/core/types.ts:TokenOut": { src: "CORE", file: "auth/schemas.py", model: "TokenOut" },
  "features/core/types.ts:TotpSetupOut": { src: "CORE", file: "auth/schemas.py", model: "TotpSetupOut" },
  "features/core/types.ts:TotpStatusOut": { src: "CORE", file: "auth/schemas.py", model: "TotpStatusOut" },
  "features/core/types.ts:UpdateUserIn": { src: "CORE", file: "auth/schemas.py", model: "UpdateUserIn" },
  "features/core/types.ts:UserOut": { src: "CORE", file: "auth/schemas.py", model: "UserOut" },
  /* --- features/ingest/types.ts --- */
  "features/ingest/types.ts:CategoryCreate": { src: "INGEST", file: "schemas.py", model: "CategoryCreate" },
  "features/ingest/types.ts:CategoryListResponse": { src: "INGEST", file: "schemas.py", model: "CategoryListResponse" },
  "features/ingest/types.ts:CategoryPublic": { src: "INGEST", file: "schemas.py", model: "CategoryPublic" },
  "features/ingest/types.ts:CategoryUpdate": { src: "INGEST", file: "schemas.py", model: "CategoryUpdate" },
  "features/ingest/types.ts:EventLogDetailOut": { src: "INGEST", file: "schemas.py", model: "EventLogDetail" },
  "features/ingest/types.ts:EventLogListResponse": { src: "INGEST", file: "schemas.py", model: "EventLogListResponse" },
  "features/ingest/types.ts:EventLogSummary": { src: "INGEST", file: "schemas.py", model: "EventLogSummary" },
  "features/ingest/types.ts:EventRuleCreate": { src: "INGEST", file: "schemas.py", model: "EventRuleCreate" },
  "features/ingest/types.ts:EventRuleListResponse": { src: "INGEST", file: "schemas.py", model: "EventRuleListResponse" },
  "features/ingest/types.ts:EventRulePublic": { src: "INGEST", file: "schemas.py", model: "EventRulePublic" },
  "features/ingest/types.ts:MatchCondition": { src: "INGEST", file: "schemas.py", model: "MatchCondition" },
  "features/ingest/types.ts:ReplayResponse": { src: "INGEST", file: "schemas.py", model: "ReplayResponse" },
  "features/ingest/types.ts:RotateSecretResponse": { src: "INGEST", file: "schemas.py", model: "RotateSecretResponse" },
  "features/ingest/types.ts:RuleTestRequest": { src: "INGEST", file: "schemas.py", model: "RuleTestRequest" },
  "features/ingest/types.ts:RuleTestResponse": { src: "INGEST", file: "schemas.py", model: "RuleTestResponse" },
  "features/ingest/types.ts:WebhookCreate": { src: "INGEST", file: "schemas.py", model: "WebhookCreate" },
  "features/ingest/types.ts:WebhookListResponse": { src: "INGEST", file: "schemas.py", model: "WebhookListResponse" },
  "features/ingest/types.ts:WebhookPublic": { src: "INGEST", file: "schemas.py", model: "WebhookPublic" },
  "features/ingest/types.ts:WebhookTestResponse": { src: "INGEST", file: "schemas.py", model: "WebhookTestResponse" },
  "features/ingest/types.ts:WebhookUpdate": { src: "INGEST", file: "schemas.py", model: "WebhookUpdate" },
  /* --- features/security/types.ts --- */
  "features/security/types.ts:DirectoryConfigIn": { src: "CORE", file: "security/schemas.py", model: "DirectoryConfigIn" },
  "features/security/types.ts:DirectoryConfigOut": { src: "CORE", file: "security/schemas.py", model: "DirectoryConfigOut" },
  "features/security/types.ts:DirectorySyncResult": { src: "CORE", file: "security/schemas.py", model: "DirectorySyncResult" },
  "features/security/types.ts:DualAuthRequestOut": { src: "CORE", file: "security/schemas.py", model: "DualAuthRequestOut" },
  "features/security/types.ts:SecurityPolicyIn": { src: "CORE", file: "security/schemas.py", model: "SecurityPolicyIn" },
  "features/security/types.ts:SecurityPolicyOut": { src: "CORE", file: "security/schemas.py", model: "SecurityPolicyOut" },
  "features/security/types.ts:SsoConfigIn": { src: "CORE", file: "security/schemas.py", model: "SsoConfigIn" },
  "features/security/types.ts:SsoConfigOut": { src: "CORE", file: "security/schemas.py", model: "SsoConfigOut" },
  /* --- features/videowall/types.ts --- */
  "features/videowall/types.ts:PresetPublic": { src: "VISION", file: "videowall/schemas.py", model: "PresetPublic" },
  "features/videowall/types.ts:ClearCellBody": { src: "VISION", file: "videowall/schemas.py", model: "ClearCellBody" },
  "features/videowall/types.ts:DecoderCreate": { src: "VISION", file: "videowall/decoder_schemas.py", model: "DecoderCreate" },
  "features/videowall/types.ts:DecoderListResponse": { src: "VISION", file: "videowall/decoder_schemas.py", model: "DecoderListResponse" },
  "features/videowall/types.ts:DecoderPublic": { src: "VISION", file: "videowall/decoder_schemas.py", model: "DecoderPublic" },
  "features/videowall/types.ts:DecoderTestResult": { src: "VISION", file: "videowall/decoder_schemas.py", model: "DecoderTestResult" },
  "features/videowall/types.ts:MonitorCreate": { src: "VISION", file: "videowall/schemas.py", model: "MonitorCreate" },
  "features/videowall/types.ts:MonitorListResponse": { src: "VISION", file: "videowall/schemas.py", model: "MonitorListResponse" },
  "features/videowall/types.ts:PresetCreate": { src: "VISION", file: "videowall/schemas.py", model: "PresetCreate" },
  "features/videowall/types.ts:PresetListResponse": { src: "VISION", file: "videowall/schemas.py", model: "PresetListResponse" },
  "features/videowall/types.ts:PushCellBody": { src: "VISION", file: "videowall/schemas.py", model: "PushCellBody" },
  "features/videowall/types.ts:TourCreate": { src: "VISION", file: "videowall/schemas.py", model: "TourCreate" },
  "features/videowall/types.ts:TourListResponse": { src: "VISION", file: "videowall/schemas.py", model: "TourListResponse" },
  "features/videowall/types.ts:TourPublic": { src: "VISION", file: "videowall/schemas.py", model: "TourPublic" },
  "features/videowall/types.ts:WallCreate": { src: "VISION", file: "videowall/schemas.py", model: "WallCreate" },
  "features/videowall/types.ts:WallListResponse": { src: "VISION", file: "videowall/schemas.py", model: "WallListResponse" },
  "features/videowall/types.ts:WallPublic": { src: "VISION", file: "videowall/schemas.py", model: "WallPublic" },
  "features/videowall/types.ts:WallStateResponse": { src: "VISION", file: "videowall/schemas.py", model: "WallStateResponse" },
  /* --- features/vms/types.ts --- */
  "features/vms/types.ts:AlarmsRollup": { src: "VISION", file: "dashboard/schemas.py", model: "AlarmsRollup" },
  "features/vms/types.ts:BookmarkCreate": { src: "VISION", file: "bookmarks/schemas.py", model: "BookmarkCreate" },
  "features/vms/types.ts:BookmarkPublic": { src: "VISION", file: "bookmarks/schemas.py", model: "BookmarkPublic" },
  "features/vms/types.ts:BulkResult": { src: "VISION", file: "cameras/schemas.py", model: "BulkResult" },
  "features/vms/types.ts:CameraACLEntry": { src: "VISION", file: "groups/schemas.py", model: "CameraACLEntry" },
  "features/vms/types.ts:CameraACLPublic": { src: "VISION", file: "groups/schemas.py", model: "CameraACLPublic" },
  "features/vms/types.ts:CameraBulkBody": { src: "VISION", file: "cameras/schemas.py", model: "CameraBulkBody" },
  "features/vms/types.ts:CameraCreate": { src: "VISION", file: "cameras/schemas.py", model: "CameraCreate" },
  "features/vms/types.ts:CameraGroupCreate": { src: "VISION", file: "groups/schemas.py", model: "CameraGroupCreate" },
  "features/vms/types.ts:CameraGroupPublic": { src: "VISION", file: "groups/schemas.py", model: "CameraGroupPublic" },
  "features/vms/types.ts:CameraHealthPublic": { src: "VISION", file: "health/schemas.py", model: "CameraHealthPublic" },
  "features/vms/types.ts:CameraReorderItem": { src: "VISION", file: "cameras/schemas.py", model: "CameraReorderItem" },
  "features/vms/types.ts:CameraRollup": { src: "VISION", file: "dashboard/schemas.py", model: "CameraRollup" },
  "features/vms/types.ts:CountBucket": { src: "VISION", file: "dashboard/schemas.py", model: "CountBucket" },
  "features/vms/types.ts:DashboardEventItem": { src: "VISION", file: "dashboard/schemas.py", model: "EventItem" },
  "features/vms/types.ts:DashboardSummary": { src: "VISION", file: "dashboard/schemas.py", model: "DashboardSummary" },
  "features/vms/types.ts:EvidenceCheckResult": { src: "VISION", file: "evidence/schemas.py", model: "EvidenceCheckResult" },
  "features/vms/types.ts:EvidenceLockCreate": { src: "VISION", file: "evidence/schemas.py", model: "EvidenceLockCreate" },
  "features/vms/types.ts:EvidenceLockPublic": { src: "VISION", file: "evidence/schemas.py", model: "EvidenceLockPublic" },
  "features/vms/types.ts:LinkageAction": { src: "VISION", file: "linkage/schemas.py", model: "LinkageAction" },
  "features/vms/types.ts:LinkageFirePublic": { src: "VISION", file: "linkage/schemas.py", model: "LinkageFirePublic" },
  "features/vms/types.ts:LinkageRuleCreate": { src: "VISION", file: "linkage/schemas.py", model: "LinkageRuleCreate" },
  "features/vms/types.ts:LinkageRulePublic": { src: "VISION", file: "linkage/schemas.py", model: "LinkageRulePublic" },
  "features/vms/types.ts:MediaNodeCreate": { src: "VISION", file: "media_nodes/schemas.py", model: "MediaNodeCreate" },
  "features/vms/types.ts:MediaNodePublic": { src: "VISION", file: "media_nodes/schemas.py", model: "MediaNodePublic" },
  "features/vms/types.ts:MediaNodeSummary": { src: "VISION", file: "dashboard/schemas.py", model: "MediaNodeSummary" },
  "features/vms/types.ts:MediaNodeUpdate": { src: "VISION", file: "media_nodes/schemas.py", model: "MediaNodeUpdate" },
  "features/vms/types.ts:MediaProfileCreate": { src: "VISION", file: "cameras/schemas.py", model: "MediaProfileCreate" },
  "features/vms/types.ts:NodesRollup": { src: "VISION", file: "dashboard/schemas.py", model: "NodesRollup" },
  "features/vms/types.ts:NvrRollup": { src: "VISION", file: "dashboard/schemas.py", model: "NvrRollup" },
  "features/vms/types.ts:OnvifConfig": { src: "VISION", file: "cameras/schemas.py", model: "OnvifConfig" },
  "features/vms/types.ts:PatternCreate": { src: "VISION", file: "patterns/schemas.py", model: "PatternCreate" },
  "features/vms/types.ts:PatternPublic": { src: "VISION", file: "patterns/schemas.py", model: "PatternPublic" },
  "features/vms/types.ts:PlaybackSessionPublic": { src: "VISION", file: "live/schemas.py", model: "PlaybackSessionPublic" },
  "features/vms/types.ts:RecordingConfigBody": { src: "VISION", file: "recording/schemas.py", model: "RecordingConfigBody" },
  "features/vms/types.ts:RecordingConfigPublic": { src: "VISION", file: "recording/schemas.py", model: "RecordingConfigPublic" },
  "features/vms/types.ts:RecordingControlResult": { src: "VISION", file: "recording/schemas.py", model: "RecordingControlResult" },
  "features/vms/types.ts:RecordingIntegrityResult": { src: "VISION", file: "storage/schemas.py", model: "RecordingIntegrityResult" },
  "features/vms/types.ts:RecordingPublic": { src: "VISION", file: "recording/schemas.py", model: "RecordingPublic" },
  "features/vms/types.ts:RecordingRollup": { src: "VISION", file: "dashboard/schemas.py", model: "RecordingRollup" },
  "features/vms/types.ts:ReorderResult": { src: "VISION", file: "cameras/schemas.py", model: "ReorderResult" },
  "features/vms/types.ts:ReportRunPublic": { src: "VISION", file: "reports/schemas.py", model: "ReportRunPublic" },
  "features/vms/types.ts:ReportScheduleCreate": { src: "VISION", file: "reports/schemas.py", model: "ReportScheduleCreate" },
  "features/vms/types.ts:ReportSchedulePublic": { src: "VISION", file: "reports/schemas.py", model: "ReportSchedulePublic" },
  "features/vms/types.ts:StoragePoolSummary": { src: "VISION", file: "dashboard/schemas.py", model: "StoragePoolSummary" },
  "features/vms/types.ts:StorageRollup": { src: "VISION", file: "dashboard/schemas.py", model: "StorageRollup" },
  "features/vms/types.ts:StreamInfoPublic": { src: "VISION", file: "cameras/schemas.py", model: "StreamInfoPublic" },
  "features/vms/types.ts:VmsCameraPublic": { src: "VISION", file: "cameras/schemas.py", model: "CameraPublic" },
  "features/vms/types.ts:VmsEventPublic": { src: "VISION", file: "events/schemas.py", model: "VmsEventPublic" },
  /* --- features/workflow/types.ts --- */
  "features/workflow/types.ts:AlertFormatPublic": { src: "WORKFLOW", file: "triggers/schemas.py", model: "AlertFormatPublic" },
  "features/workflow/types.ts:AssignInstanceRequest": { src: "WORKFLOW", file: "instances/schemas.py", model: "AssignInstanceRequest" },
  "features/workflow/types.ts:AssignableRole": { src: "CORE", file: "auth/schemas.py", model: "RoleOut", subset: "the role picker renders three columns of the role row" },
  "features/workflow/types.ts:AssignableUser": { src: "CORE", file: "auth/schemas.py", model: "UserOut", subset: "the assignee picker renders four columns of the user row" },
  "features/workflow/types.ts:ChannelPublic": { src: "WORKFLOW", file: "notifications/schemas.py", model: "ChannelPublic" },
  "features/workflow/types.ts:CreateAlertFormatRequest": { src: "WORKFLOW", file: "triggers/schemas.py", model: "CreateAlertFormatRequest" },
  "features/workflow/types.ts:CreateChannelRequest": { src: "WORKFLOW", file: "notifications/schemas.py", model: "CreateChannelRequest" },
  "features/workflow/types.ts:CreateFormRequest": { src: "WORKFLOW", file: "forms/schemas.py", model: "CreateFormRequest" },
  "features/workflow/types.ts:CreateSopRequest": { src: "WORKFLOW", file: "sops/schemas.py", model: "CreateSopRequest" },
  "features/workflow/types.ts:CreateStateRequest": { src: "WORKFLOW", file: "sops/schemas.py", model: "CreateStateRequest" },
  "features/workflow/types.ts:CreateTemplateRequest": { src: "WORKFLOW", file: "notifications/schemas.py", model: "CreateTemplateRequest" },
  "features/workflow/types.ts:CreateTransitionRequest": { src: "WORKFLOW", file: "sops/schemas.py", model: "CreateTransitionRequest" },
  "features/workflow/types.ts:CreateTriggerRequest": { src: "WORKFLOW", file: "triggers/schemas.py", model: "CreateTriggerRequest" },
  "features/workflow/types.ts:DedupConfig": { src: "WORKFLOW", file: "triggers/schemas.py", model: "DedupConfig" },
  "features/workflow/types.ts:EscalateInstanceRequest": { src: "WORKFLOW", file: "instances/schemas.py", model: "EscalateInstanceRequest" },
  "features/workflow/types.ts:EscalationRule": { src: "WORKFLOW", file: "sops/schemas.py", model: "EscalationRule" },
  "features/workflow/types.ts:FormFieldSchema": { src: "WORKFLOW", file: "forms/schemas.py", model: "FormFieldSchema" },
  "features/workflow/types.ts:FormPublic": { src: "WORKFLOW", file: "forms/schemas.py", model: "FormPublic" },
  "features/workflow/types.ts:InstancePublic": { src: "WORKFLOW", file: "instances/schemas.py", model: "InstancePublic" },
  "features/workflow/types.ts:InstanceStatsResponse": { src: "WORKFLOW", file: "instances/schemas.py", model: "InstanceStatsResponse" },
  "features/workflow/types.ts:SetThreatLevelRequest": { src: "WORKFLOW", file: "threat_levels/schemas.py", model: "SetThreatLevelRequest" },
  "features/workflow/types.ts:SimulateEventRequest": { src: "WORKFLOW", file: "triggers/schemas.py", model: "SimulateEventRequest" },
  "features/workflow/types.ts:SimulateEventResponse": { src: "WORKFLOW", file: "triggers/schemas.py", model: "SimulateEventResponse" },
  "features/workflow/types.ts:SimulateMatchedFormat": { src: "WORKFLOW", file: "triggers/schemas.py", model: "SimulateMatchedFormat" },
  "features/workflow/types.ts:SimulateMatchedTrigger": { src: "WORKFLOW", file: "triggers/schemas.py", model: "SimulateMatchedTrigger" },
  "features/workflow/types.ts:SimulateSkipped": { src: "WORKFLOW", file: "triggers/schemas.py", model: "SimulateSkipped" },
  "features/workflow/types.ts:SopPublic": { src: "WORKFLOW", file: "sops/schemas.py", model: "SopPublic" },
  "features/workflow/types.ts:StatePublic": { src: "WORKFLOW", file: "sops/schemas.py", model: "StatePublic" },
  "features/workflow/types.ts:StatusChangeRequest": { src: "WORKFLOW", file: "instances/schemas.py", model: "StatusChangeRequest" },
  "features/workflow/types.ts:TemplatePublic": { src: "WORKFLOW", file: "notifications/schemas.py", model: "TemplatePublic" },
  "features/workflow/types.ts:ThreatLevelPublic": { src: "WORKFLOW", file: "threat_levels/schemas.py", model: "ThreatLevelPublic" },
  "features/workflow/types.ts:TransitionCondition": { src: "WORKFLOW", file: "sops/schemas.py", model: "TransitionCondition" },
  "features/workflow/types.ts:TransitionInstanceRequest": { src: "WORKFLOW", file: "instances/schemas.py", model: "TransitionInstanceRequest" },
  "features/workflow/types.ts:TransitionPublic": { src: "WORKFLOW", file: "sops/schemas.py", model: "TransitionPublic" },
  "features/workflow/types.ts:TriggerPublic": { src: "WORKFLOW", file: "triggers/schemas.py", model: "TriggerPublic" },
};

/** Counted by hand in the sources (see the test that uses them). */
const EXPECTED_COUNTS = {
  CameraPublic: 26,
  SitePublic: 23,
  InstancePublic: 30,
  WebhookPublic: 17,
};

/** TS interface → the hand-built dict payload it mirrors. `extra` names keys the
 *  handler adds outside the literal (a child list built after the fact). */
interface DictEntry {
  file: string;
  marker: string;
  /** Where to start looking for the literal — `"return {"` skips earlier dicts. */
  open?: string;
  extra?: string[];
  reason?: string;
}

const DICTS: Record<string, DictEntry> = {
  "lib/types.ts:SiteTreeNode": {
    file: "backend/core/app/sites/site/service.py",
    marker: "async def get_tree",
    extra: ["children"], // stitched on after the row dicts are built
  },
  "lib/types.ts:SearchResult": {
    file: "backend/core/app/search/router.py",
    marker: "results.append(",
  },
  "lib/types.ts:SearchResponse": {
    file: "backend/core/app/search/router.py",
    marker: "if not term:",
  },
  "lib/types.ts:Entitlements": {
    file: "backend/core/app/tenancy/entitlements.py",
    marker: "def effective_entitlements(",
    open: "return {",
  },
  "lib/types.ts:ModuleEntitlement": {
    file: "backend/core/app/tenancy/entitlements.py",
    marker: "module_out = [",
  },
  "lib/types.ts:GpuSample": {
    file: "backend/core/app/system/resources.py",
    marker: "gpus.append(",
  },
  "lib/types.ts:SystemResourcesSnapshot": {
    file: "backend/core/app/system/resources.py",
    marker: "def sample_resources(",
    open: "return {",
  },
  "lib/types.ts:FederatedCameraList": {
    file: "backend/vision/app/vms/federation/estate.py",
    marker: "async def federated_cameras(",
    open: 'return {"items"',
  },
  "features/access/types.ts:AccessCardholder": {
    file: "backend/access/app/access/writethrough.py",
    marker: "def _cardholder_from_dds(",
    open: "return {",
  },
  "features/core/types.ts:SetupStatus": {
    file: "backend/core/app/auth/routes/session.py",
    marker: "async def setup_status(",
    open: "return {",
  },
  "features/core/types.ts:PermissionEntry": {
    file: "backend/core/app/auth/permissions.py",
    marker: "def grouped(",
    open: "setdefault(",
  },
  "features/core/types.ts:UserImportResult": {
    file: "backend/core/app/auth/routes/users.py",
    marker: "async def import_users(",
    open: 'return {"created"',
  },
  "features/core/types.ts:AuditPurgeOut": {
    file: "backend/core/app/core/audit.py",
    marker: "async def purge_audit(",
    open: 'return {"deleted"',
  },
  "features/core/types.ts:TemplatePreviewOut": {
    file: "backend/core/app/messaging/router.py",
    marker: "async def preview_template(",
    open: "return {",
  },
  "features/core/types.ts:LicenseStatus": {
    file: "backend/core/app/licensing/router.py",
    marker: "def _status(",
    open: "return {",
  },
  "features/core/types.ts:SystemHealthOut": {
    file: "backend/core/app/system/router.py",
    marker: "async def get_health(",
    open: 'return {"status"',
  },
  "lib/types.ts:DevicePlacementIndexRow": {
    file: "backend/core/app/sites/device/service.py",
    marker: "async def estate_index(",
    open: "return [",
  },
  "lib/types.ts:DevicePlacementIndexResponse": {
    file: "backend/core/app/sites/device/router.py",
    marker: "async def estate_index(",
    open: 'return {"items"',
  },
  "features/core/types.ts:ServiceOut": {
    file: "backend/core/app/system/router.py",
    marker: "def _service_row(",
    open: "return {",
  },
  "features/core/types.ts:ServiceLogsOut": {
    file: "backend/core/app/system/router.py",
    marker: "async def service_logs(",
    open: 'or {"lines"',
  },
  "features/vms/types.ts:FederationNode": {
    file: "backend/vision/app/vms/federation/estate.py",
    marker: "async def list_nodes(",
    open: '"items": [',
  },
};

/** Ours, not the backend's. Each reason says which kind of local shape it is. */
const LOCAL: Record<string, string> = {
  // ── the playback shapes, after the VMS stopped serving footage ─────────────
  // `app/vms/playback/schemas.py` is gone with the endpoints that answered about
  // this platform's own pooled storage. These are what the CONSOLE builds now:
  // segments folded from the owning recorder's ranges, markers built from the
  // mirrored camera events, and the calendar's footage days derived client-side
  // from a month of those ranges (nodes expose no recording-days endpoint).
  "features/vms/types.ts:PlaybackRange": "one span as the owning recorder reports it (start + duration)",
  "features/vms/types.ts:TimelineSegment": "folded from the recorder's own timeline ranges",
  "features/vms/types.ts:TimelineMarker": "built from VmsEventPublic for the scrub bar",
  "features/vms/types.ts:RecordingDaysResponse": "derived client-side from a month of recorder ranges",

  "lib/types.ts:ApiErrorBody": "the shared error envelope, shaped by the exception handler; every field optional",
  "lib/types.ts:Paged": "generic list envelope (items/total/skip/limit), not a model",
  "lib/types.ts:PublicSettings": "an open map of catalog values; only the keys this console reads are named",
  "features/access/types.ts:SyncCollectionCounts": "the known keys of SyncJobPublic.counts, typed dict[str, Any] on the backend",
  "features/access/types.ts:AccessEventFrame": "an SSE frame shape, not a REST body",
  "features/access/types.ts:NormalizedAccessEvent": "view model — the union of event shapes normalised for one table",
  "features/access/types.ts:HardwareListResponse": "generic envelope over opaque controller hardware rows",
  "features/ingest/types.ts:BuilderField": "rule-builder UI draft",
  "features/ingest/types.ts:ConditionDraft": "rule-builder UI draft",
  "features/ingest/types.ts:FieldMapRow": "rule-builder UI draft",
  "features/ingest/types.ts:RuleDraft": "rule-builder UI draft",
  "features/videowall/types.ts:WallStateFrame": "a wall-state WebSocket frame, not a REST body",
  "features/videowall/types.ts:WallFrameMeta": "a wall-state WebSocket frame, not a REST body",
  "features/vms/types.ts:ItemList": "generic `{ items }` envelope used by the VMS list endpoints",
  "features/vms/types.ts:DrawnRect": "canvas drawing shape for the mask/zone editor",
  "features/vms/types.ts:DrawnPolygon": "canvas drawing shape for the mask/zone editor",
  "features/vms/types.ts:HostCredentials": "the credential trio several probe/bulk-add bodies share",
  "features/vms/types.ts:VmsEventFrame": "an SSE frame (a partial event), not a REST body",
  "features/vms/types.ts:NodeTagged": "the `node_id`/`node_name` tag the federation router stamps onto proxied payloads",
  "features/vms/types.ts:EstateFederatedCamera": "view model — a federated camera flattened for the estate grid",
  "features/vms/types.ts:EstateCamera": "view model — the union of local and federated cameras",
  "features/vms/types.ts:IsoWindow": "a from/to pair the playback helpers pass around",
  "features/vms/types.ts:LiveSessionLike": "structural type over the several session shapes the player accepts",
  "features/vms/types.ts:LiveSessionSource": "player wiring, not a wire shape",
  "features/vms/types.ts:PlayableSession": "player wiring, not a wire shape",
  "features/vms/types.ts:CoverageSpan": "timeline view model — one contiguous span of coverage",
  "features/vms/types.ts:MotionHitLike": "structural type over local and federated motion hits",
  "features/vms/types.ts:ExportRangeRequest": "the export dialog's draft before it becomes an ExportStartBody",
  "features/vms/types.ts:CameraForm": "the camera wizard's form state",
  "features/vms/types.ts:WallPreset": "view model for the wall preset picker",
  "features/vms/types.ts:PatternStop": "view model for the PTZ pattern editor",
  "features/vms/types.ts:VmsPopupFrame": "an alarm popup frame assembled in the browser",
  "features/vms/types.ts:ReportRow": "view model over ReportResponse's kind-specific open rows",
  "features/vms/types.ts:AlarmSeverityBreakdown": "view model over ReportResponse.totals",
  "features/vms/types.ts:ReportTotals": "view model over ReportResponse.totals",
  "features/vms/types.ts:ReportViewData": "view model the Reports screen renders from",
  "features/workflow/types.ts:TransitionNotificationConfig": "the known keys of TransitionPublic.notification, typed dict on the backend",
  "features/workflow/types.ts:FormFieldOption": "the known keys of a FormFieldSchema option, typed dict on the backend",
  "features/workflow/types.ts:FormFieldValidation": "the known keys of FormFieldSchema.validation, typed dict on the backend",
  "features/workflow/types.ts:TriggerEnvelope": "the known keys of InstancePublic.trigger_event, typed dict on the backend",
  "features/workflow/types.ts:TimelineEntry": "the known keys of an InstancePublic.timeline row, typed dict on the backend",
  "features/workflow/types.ts:InstanceAssignment": "the known keys of an InstancePublic.assignments row, typed dict on the backend",
  "features/workflow/types.ts:InstanceEscalation": "the known keys of an InstancePublic.escalations row, typed dict on the backend",
  "features/workflow/types.ts:IncidentStreamEvent": "an SSE frame from the realtime bridge, not a REST body",
};

/** Wire shapes with no machine-readable source in THIS repo. */
const PASSTHROUGH: Record<string, string> = {
  // ── Pulse ──────────────────────────────────────────────────────────────────
  // The estate roll-up is assembled in `app/vms/pulse/rollup.py` from each
  // recorder's own board — dicts built by a function, not Pydantic models, so
  // there is no class here to compare against. The rules that matter about these
  // shapes are the nulls (an unmeasured volume, a recorder that is not
  // recording), and those are guarded on both sides by name:
  // `tests/test_pulse_rollup.py` and `features/vms/pulse/format.test.ts`.
  "features/vms/types.ts:PulseOverview": "assembled by pulse/rollup.overview() — a dict, not a model",
  "features/vms/types.ts:PulseNode": "assembled by pulse/rollup.node_view() from the recorder's own board",
  "features/vms/types.ts:PulseNodeCameras": "the cameras block of pulse/rollup.node_view()",
  "features/vms/types.ts:PulseVolume": "one volume of pulse/rollup.node_view(), from the recorder's volumeView",
  "features/vms/types.ts:PulseOfflineCamera": "built by pulse/rollup.offline_cameras() from the recorder's camera rows",
  "features/vms/types.ts:PulseAttentionItem": "built by pulse/rollup.attention_items()",
  "features/vms/types.ts:NodeSysmon": "the recorder's own System-Monitor board, relayed unreshaped",
  "features/vms/types.ts:IsolationTrace": "the recorder's own fault trace, relayed unreshaped",
  "features/vms/types.ts:IsolationStage": "one stage of the recorder's fault trace",

  "lib/types.ts:FederatedCamera": "the remote recorder's own camera dict, tagged and forwarded verbatim",
  "features/access/types.ts:AccessCard": "the controller's card DTO with seven keys renamed; the rest pass through",
  "features/core/types.ts:SettingCatalogItem": "one CATALOG entry in settings/catalog.py — entries carry different optional keys per setting, so there is no single literal to compare",
  "features/core/types.ts:PermissionCatalog": "an envelope around PermissionRegistry.grouped(); the entry shape is checked as PermissionEntry",
  "features/ingest/types.ts:ConditionResult": "a row inside RuleTestResponse.conditions, typed list[dict] on the backend",
  "features/vms/types.ts:RecordingActiveResponse": "built by the recording service, not a model",
  "features/vms/types.ts:LinkageCameraScope": "the known keys of LinkageRule.camera_scope, typed dict on the backend",
  "features/vms/types.ts:DeviceUserPublic": "ONVIF device accounts, shaped by the camera driver",
  "features/vms/types.ts:ReportResponse": "the reports service builds one dict per report kind; rows and totals are kind-specific",
  "features/vms/types.ts:NodeCredentialPublic": "built by the media-node service from the credential row",
  "features/vms/types.ts:NodeEnrollResult": "built by the media-node service when it mints a credential",
  "features/vms/types.ts:FederatedLiveSession": "proxied verbatim from a remote recorder",
  "features/vms/types.ts:FederatedTimeline": "proxied verbatim from a remote recorder",
  "features/vms/types.ts:FederatedRecording": "proxied verbatim from a remote recorder",
  "features/vms/types.ts:FederatedRecordingList": "proxied verbatim from a remote recorder",
  "features/vms/types.ts:FederatedPlaybackSession": "proxied verbatim from a remote recorder",
  "features/vms/types.ts:FederatedPtzBody": "forwarded verbatim to a remote recorder",
  "features/vms/types.ts:PtzMoveBody": "the move payload the recorder forwards to the device — no VMS model behind it",
  "features/vms/types.ts:PtzResult": "the recorder's PTZ result, proxied verbatim",
  "features/vms/types.ts:FederatedOpResult": "proxied verbatim from a remote recorder",
  "features/vms/types.ts:FederatedPreset": "the CAMERA's own preset, read through the recorder — no VMS model behind it",
  "features/vms/types.ts:FederatedPresetList": "the CAMERA's own presets, read through the recorder — no VMS model behind it",
  "features/vms/types.ts:FederatedPatrol": "the recorder's host-driven patrol, proxied verbatim — the VMS stores none",
  "features/vms/types.ts:FederatedPatrolStop": "part of the recorder's host-driven patrol, proxied verbatim",
  "features/vms/types.ts:FederatedPatrolBody": "forwarded verbatim to a remote recorder",
  "features/vms/types.ts:FederatedExportJob": "proxied verbatim from a remote recorder",
  "features/vms/types.ts:FederatedExportVerify": "the recorder's own verification of its own clip, proxied verbatim",
  "features/vms/types.ts:FederatedExportPublicKey": "the recorder's export signing identity, proxied verbatim",
  "features/vms/types.ts:FederatedMotionSearch": "the recorder's forensic search result, proxied verbatim",
  "features/vms/types.ts:FederatedMotionSearchBody": "forwarded verbatim to a remote recorder",
  "features/vms/types.ts:FederatedCoverageGap": "part of the recorder's search result, proxied verbatim",
  "features/vms/types.ts:FederatedNvr": "a third-party NVR as the RECORDER reports it — it owns the appliance, so the shape is its own",
  "features/vms/types.ts:FederatedNvrList": "the recorders' appliance lists, merged and tagged; no VMS model behind it",
  "features/vms/types.ts:ProbeResponse": "the recorder's device-probe answer, proxied verbatim",
  "features/vms/types.ts:FederatedBackchannel": "the recorder's talk-back capability + transport readiness, proxied verbatim",
  "features/vms/types.ts:MotionHit": "one hit as the recorder reports it — no VMS model behind it",
  "features/vms/types.ts:MotionRegion": "the rectangle forwarded verbatim to a remote recorder",
  "features/vms/types.ts:FederatedHold": "proxied verbatim from a remote recorder",
  "features/vms/types.ts:NodeStorageUsage": "proxied verbatim from a remote recorder's storage API",
  "features/vms/types.ts:NodeRaidArray": "proxied verbatim from a remote recorder's storage API",
  "features/vms/types.ts:NodeRaidStatus": "proxied verbatim from a remote recorder's storage API",
  "features/vms/types.ts:NodeStoragePool": "proxied verbatim from a remote recorder's storage API",
  "features/vms/types.ts:NodeStoragePoolList": "proxied verbatim from a remote recorder's storage API",
  "features/vms/types.ts:NodeTierRule": "proxied verbatim from a remote recorder's storage API",
  "features/vms/types.ts:NodeTierRuleList": "proxied verbatim from a remote recorder's storage API",
  "features/vms/types.ts:NodeUpstreamNvrStorage": "proxied verbatim from a remote recorder's storage API",
};

/**
 * Fields the backend sends that a screen deliberately does not model. Never a
 * bare waiver: each needs a reason.
 */
const NOT_MODELLED: Record<string, Record<string, string>> = {
  "features/core/types.ts:CreateUserIn": {
    tenant_id: "a super-admin-only field; the operator console never places a user in another tenant",
  },
  "features/vms/types.ts:PlaybackRange": {
    trigger_type: "present on the federated recorder's ranges, absent on vision's; declared optional so both parse",
  },
};

function fieldsOf(entry: ModelEntry): ModelField[] {
  const base = SRC[entry.src];
  if (!base) throw new Error(`unknown backend source ${entry.src}`);
  const file = path.join(base, entry.file);
  // `from_: datetime = Field(alias="from")` goes on the wire as `from`, so the
  // TypeScript is right to say `from` — compare against the wire name.
  const aliases = parseFieldAliases(file);
  return resolveFields(parseModels(file), entry.model).map((f) =>
    aliases.has(f.name) ? { ...f, name: aliases.get(f.name)! } : f
  );
}

describe("the operator console's types mirror the backend models", () => {
  it("accounts for every exported interface", () => {
    const unaccounted = [...interfaces.keys()].filter(
      (k) => !MAPPING[k] && !DICTS[k] && !LOCAL[k] && !PASSTHROUGH[k]
    );

    // A new wire type cannot be added without saying what it mirrors.
    expect(unaccounted).toEqual([]);
  });

  it("gives every LOCAL and PASSTHROUGH interface a real reason", () => {
    const bare = [...Object.entries(LOCAL), ...Object.entries(PASSTHROUGH)]
      .filter(([, why]) => why.trim().length < 20)
      .map(([k]) => k);

    expect(bare).toEqual([]);
  });

  // A reader that silently returned nothing would make every comparison below
  // pass. These two tests are the guard on the reader itself.
  it("actually reads fields out of every mapped model", () => {
    const empty = Object.entries(MAPPING)
      .filter(([, entry]) => fieldsOf(entry).length === 0)
      .map(([k]) => k);

    expect(empty).toEqual([]);
  });

  it("reads the models in full, not just their first few lines", () => {
    // Spot-checked by hand against the sources: a parser regression (a docstring
    // swallowing a class body, say) shows up here as a smaller count.
    const counts = {
      CameraPublic: fieldsOf(MAPPING["lib/types.ts:CameraPublic"]!).length,
      SitePublic: fieldsOf(MAPPING["lib/types.ts:SitePublic"]!).length,
      InstancePublic: fieldsOf(MAPPING["features/workflow/types.ts:InstancePublic"]!).length,
      WebhookPublic: fieldsOf(MAPPING["features/ingest/types.ts:WebhookPublic"]!).length,
    };

    expect(counts).toEqual(EXPECTED_COUNTS);
  });

  it("reads keys out of every dict payload", () => {
    const empty = Object.entries(DICTS)
      .filter(([, d]) => dictKeys(d).length === 0)
      .map(([k]) => k);

    expect(empty).toEqual([]);
  });
});

function dictKeys(entry: DictEntry): string[] {
  return [
    ...parseDictKeys(path.join(ROOT, entry.file), entry.marker, entry.open ?? "{"),
    ...(entry.extra ?? []),
  ];
}

/**
 * The two loops below GENERATE the suite. An empty map would not fail — it would
 * produce no tests at all, and a file with nothing in it passes. So the maps are
 * asserted non-empty before anything is generated from them.
 */
describe("the contract suite has something to check", () => {
  it("was built from a populated mapping", () => {
    expect(Object.keys(MAPPING).length).toBeGreaterThan(5);
  });

  it("was built from a populated dictionary set", () => {
    expect(Object.keys(DICTS).length).toBeGreaterThan(0);
  });
});

for (const [key, entry] of Object.entries(MAPPING)) {
  describe(`${key} ↔ ${entry.model}`, () => {
    it("declares no field the model does not have", () => {
      const modelNames = new Set(fieldsOf(entry).map((f) => f.name));
      const allowed = NOT_MODELLED[key] ?? {};
      const invented = propsOf(key)
        .map((p) => p.name)
        .filter((n) => !modelNames.has(n) && !allowed[n]);

      // This is the bug class: a field the UI reads and the API never sends,
      // which arrives undefined and renders as nothing at all.
      expect(invented).toEqual([]);
    });

    it("declares every field the model always sends", () => {
      if (entry.subset) return; // a declared partial view — see `subset`
      const props = new Set(propsOf(key).map((p) => p.name));
      const allowed = NOT_MODELLED[key] ?? {};
      const missing = fieldsOf(entry)
        .filter((f) => f.required && !props.has(f.name) && !allowed[f.name])
        .map((f) => f.name);

      expect(missing).toEqual([]);
    });

    it("declares the model's optional fields too, or says why not", () => {
      if (entry.subset) return;
      const props = new Set(propsOf(key).map((p) => p.name));
      const allowed = NOT_MODELLED[key] ?? {};
      const missing = fieldsOf(entry)
        .filter((f) => !f.required && !props.has(f.name) && !allowed[f.name])
        .map((f) => f.name);

      expect(missing).toEqual([]);
    });

    it("admits null wherever the model does", () => {
      // Only for what the console READS. A request body may decline to send a
      // nullable field (an absent key and an explicit null mean the same thing
      // to the server); a response field typed non-null that arrives null is
      // the crash this guards against.
      if (/(Create|Update|Body|Request|In)$/.test(entry.model)) return;
      const props = new Map(propsOf(key).map((p) => [p.name, p]));
      const wrong = fieldsOf(entry)
        .filter((f) => f.nullable)
        .filter((f) => {
          const prop = props.get(f.name);
          if (!prop) return false; // covered by the tests above
          return !prop.optional && !/\bnull\b/.test(prop.type);
        })
        .map((f) => f.name);

      // A field typed `string` that arrives null is how a dash turns into a
      // crash on `.slice()`.
      expect(wrong).toEqual([]);
    });
  });
}

for (const [key, entry] of Object.entries(DICTS)) {
  describe(`${key} ↔ ${entry.marker}`, () => {
    it("declares no key the payload does not have", () => {
      const keys = new Set(dictKeys(entry));
      const invented = propsOf(key)
        .map((p) => p.name)
        .filter((n) => !keys.has(n));

      expect(invented).toEqual([]);
    });

    it("declares every key the payload sends", () => {
      if (hasIndexSignature(key)) return; // absorbs unknown keys by design
      const props = new Set(propsOf(key).map((p) => p.name));
      const allowed = NOT_MODELLED[key] ?? {};
      const missing = dictKeys(entry).filter((k) => !props.has(k) && !allowed[k]);

      expect(missing).toEqual([]);
    });
  });
}
