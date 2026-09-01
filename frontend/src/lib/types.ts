// Shared API shapes. These describe what the edge backend actually returns, and
// are deliberately partial: only the fields the UI reads are modelled, and the
// catch-all index signature keeps a response with extra fields assignable while
// the rest of the tree is still JavaScript.

/** Anything the backend hands back that we have not modelled yet. */
export type Json = Record<string, any>;

/** The standard list envelope. Some endpoints return a bare array instead — see
 *  `asItems` in lib/format, which normalises both. */
export interface Paged<T> {
  items: T[];
  total?: number;
  skip?: number;
  limit?: number;
}

/** The uniform error envelope: `{ error: { code, message } }`. */
export interface ApiErrorBody {
  error?: { code?: string; message?: string };
}

export interface Role {
  id?: string;
  name?: string;
  /** `"*"` means admin — see `can()` in lib/auth. */
  permissions?: string[];
  [k: string]: any;
}

export interface User {
  id?: string;
  email?: string;
  name?: string;
  role?: Role;
  totp_enabled?: boolean;
  is_active?: boolean;
  [k: string]: any;
}

export interface EntitlementModule {
  key: string;
  enabled?: boolean;
  [k: string]: any;
}

/** GET /features — the caller's effective entitlements, resolved from their tenant. */
export interface Entitlements {
  modules?: EntitlementModule[];
  limits?: Record<string, number>;
  license_state?: string | null;
  [k: string]: any;
}

/** POST /auth/login. When 2FA is on the backend withholds tokens and returns a
 *  challenge instead. */
export interface LoginResponse {
  access_token?: string;
  refresh_token?: string;
  mfa_required?: boolean;
  mfa_token?: string;
}

export interface LoginResult {
  mfaRequired: boolean;
  mfaToken?: string;
}

export type ThreatLevel = "normal" | "elevated" | "high" | "critical" | string;

export interface Site {
  id?: string;
  name?: string;
  threat_level?: ThreatLevel;
  is_active?: boolean;
  [k: string]: any;
}

export interface Floor {
  id?: string;
  site_id?: string;
  name?: string;
  [k: string]: any;
}

export interface Zone {
  id?: string;
  floor_id?: string;
  name?: string;
  threat_level?: ThreatLevel;
  [k: string]: any;
}

/** A device pinned onto a floor plan at { x, y, rotation }. */
export interface DevicePlacement {
  device_id?: string;
  floor_id?: string;
  zone_id?: string;
  service?: string;
  device_type?: string;
  x?: number;
  y?: number;
  rotation?: number;
  [k: string]: any;
}

export interface Tag {
  id?: string;
  name?: string;
  color?: string;
  [k: string]: any;
}

export type EntityRef = { entity_type: string; entity_id: string };

/** An entry in the floor-builder's placeable-device palette. */
export interface InventoryDevice {
  id: string;
  name?: string;
  status?: string;
  [k: string]: any;
}
