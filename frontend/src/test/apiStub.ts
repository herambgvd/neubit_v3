import axios, { AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from "axios";

import { api } from "@/lib/api";

/**
 * A route table served straight off the axios adapter, so nothing here touches a
 * network and — the reason this exists rather than a per-module `vi.spyOn` — every
 * test can read the REQUEST BODY the screen actually sent. Several bugs in these
 * features were fields the UI sent that the API has no column for; that is only
 * visible at the wire.
 *
 * Keys are `"<METHOD> <path>"` with the query string stripped. A key ending in
 * `/*` matches by prefix, which is how `/auth/users/:id` style routes are declared.
 * An unmatched request rejects loudly instead of resolving empty, so a screen that
 * calls something the test did not anticipate fails rather than passing vacuously.
 */

/** One request the screen made. `body` is the parsed JSON payload. */
export interface Recorded {
  method: string;
  url: string;
  body: Record<string, unknown> | undefined;
  params: Record<string, unknown> | undefined;
  /** The query string as SENT. Some api modules build the query into the URL
   *  (`qs(params)`) rather than handing axios a params object, so `params` is
   *  undefined for them and this is the only place the values appear. */
  search: URLSearchParams;
}

/** A handler returns the response body, or throws (use `httpError`) to fail. */
export type RouteHandler = (req: Recorded) => unknown;
export type Routes = Record<string, RouteHandler | unknown>;

export interface ApiStub {
  /** Every request, in order. */
  calls: Recorded[];
  /** The calls matching a `"<METHOD> <path>"` key (prefix keys allowed). */
  matching: (key: string) => Recorded[];
  /** The single body sent to `key`; fails the caller's assertion when absent. */
  body: (key: string) => Record<string, unknown> | undefined;
  /** Replace or add routes mid-test (e.g. make the second load fail). */
  set: (routes: Routes) => void;
}

/**
 * Reject a route the way the backend's error envelope does.
 *
 * `code` is the MACHINE code from `{ error: { code } }` (kernel/errors.py). Some
 * screens branch on it rather than on message text — a 409/CONFLICT on a webhook
 * slug is reported on the slug field, any other failure is not — so a test of
 * that branch has to be able to set it. Defaults to the generic "ERR", so every
 * existing caller is unaffected.
 */
export function httpError(status: number, message = "boom", code = "ERR"): never {
  const err = new AxiosError(message, String(status));
  err.response = {
    data: { error: { code, message } },
    status,
    statusText: "ERR",
    headers: {},
    config: {} as InternalAxiosRequestConfig,
  } as AxiosResponse;
  throw err;
}

function parseBody(data: unknown): Record<string, unknown> | undefined {
  if (typeof data !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(data);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function keyMatches(key: string, method: string, path: string): boolean {
  const [m, p] = key.split(" ");
  if (m.toUpperCase() !== method) return false;
  if (p.endsWith("/*")) return path.startsWith(p.slice(0, -1));
  return p === path;
}

export function stubApi(routes: Routes): ApiStub {
  let table: Routes = { ...routes };
  const calls: Recorded[] = [];

  // The bare axios instance only ever serves /auth/refresh (the httpOnly cookie
  // probe). Signed-out by default: a null token, not a failure.
  axios.defaults.adapter = async (config) =>
    ({
      data: { access_token: null },
      status: 200,
      statusText: "OK",
      headers: {},
      config,
    }) as AxiosResponse;

  api.defaults.adapter = async (config) => {
    const method = (config.method || "get").toUpperCase();
    const path = (config.url || "").split("?")[0];
    const req: Recorded = {
      method,
      url: path,
      body: parseBody(config.data),
      params: config.params as Record<string, unknown> | undefined,
      search: new URLSearchParams((config.url || "").split("?")[1] || ""),
    };
    calls.push(req);

    const hit = Object.keys(table).find((k) => keyMatches(k, method, path));
    if (hit === undefined) {
      return Promise.reject(new AxiosError(`no stub for ${method} ${path}`, "404"));
    }
    const value = table[hit];
    const data: unknown = typeof value === "function" ? (value as RouteHandler)(req) : value;
    return { data, status: 200, statusText: "OK", headers: {}, config } as AxiosResponse;
  };

  return {
    calls,
    matching: (key) => calls.filter((c) => keyMatches(key, c.method, c.url)),
    body: (key) => calls.find((c) => keyMatches(key, c.method, c.url))?.body,
    set: (next) => {
      table = { ...table, ...next };
    },
  };
}

/** A `Paged<T>` envelope; the list screens read `items` + `total`. */
export function paged<T>(items: T[]) {
  return { items, total: items.length, page: 1, page_size: 100 };
}
