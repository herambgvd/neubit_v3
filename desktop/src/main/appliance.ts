import { app, net } from "electron";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { LocalServerState, ServiceResult } from "@shared/ipc";
import { log } from "./logger";

// The VMS server on THIS machine, as the native appliance runs it: the Windows
// Service "NeubitVMS" (appliance/, docs/WINDOWS_NATIVE_APPLIANCE.md). The shell
// is its client, never its parent — the server runs with nobody signed in, and
// quitting the app must not stop it.
//
// The shell finds it the way the NVR shell finds its recorder: the control API
// writes its address to <data root>\config\control.json; the data root is in the
// registry (64-bit view) or the default; failing both, the default port. Then
// /v1/status says where the console is and whether it is ready. None of this
// needs elevation. Starting, stopping and restarting the service does, and goes
// through neubitvms-svc.exe under a UAC prompt.

const DEFAULT_CONTROL = "127.0.0.1:18079";
const STATUS_TIMEOUT_MS = 2_500;

export interface ApplianceProcess {
  name: string;
  state: string;
  restarts: number;
  last_error?: string;
  one_shot: boolean;
  critical: boolean;
}

export interface ApplianceStatus {
  /** The control API answered: a VMS server is installed and its service is running. */
  present: boolean;
  ready: boolean;
  healthy: number;
  total: number;
  /** The console for this machine (http://localhost[:port]). */
  localUrl?: string;
  /** The address LAN browsers use. */
  lanUrl?: string;
  dataRoot?: string;
  logDir?: string;
  version?: string;
  processes: ApplianceProcess[];
  reason?: string;
}

interface WireStatus {
  version: string;
  ready: boolean;
  healthy: number;
  total: number;
  ui_url: string;
  lan_url: string;
  data_root: string;
  log_dir: string;
  processes: ApplianceProcess[];
}

/** Read HKLM\SOFTWARE\Neubit\VMS\DataRoot from the 64-bit view via reg.exe (no
 *  native module, no elevation). */
function registryDataRoot(): Promise<string | null> {
  if (process.platform !== "win32") return Promise.resolve(null);
  const reg = path.join(
    process.env.SystemRoot ?? String.raw`C:\Windows`,
    "System32",
    "reg.exe",
  );
  return new Promise((resolve) => {
    execFile(
      reg,
      ["query", String.raw`HKLM\SOFTWARE\Neubit\VMS`, "/v", "DataRoot", "/reg:64"],
      { windowsHide: true, timeout: 3_000 },
      (err, stdout) => {
        if (err) return resolve(null);
        const m = /DataRoot\s+REG_\w+\s+(\S.*)$/m.exec(stdout);
        resolve(m ? m[1].trim() : null);
      },
    );
  });
}

export async function dataRoot(): Promise<string> {
  if (process.env.NEUBIT_VMS_ROOT) return process.env.NEUBIT_VMS_ROOT;
  const reg = await registryDataRoot();
  if (reg) return reg;
  return path.join(process.env.ProgramData ?? String.raw`C:\ProgramData`, "Neubit", "VMS");
}

async function controlAddress(): Promise<string> {
  try {
    const raw = await readFile(
      path.join(await dataRoot(), "config", "control.json"),
      "utf8",
    );
    const addr = (JSON.parse(raw) as { addr?: string }).addr;
    // Loopback only: this file is a hint, and the shell must never be steered
    // off the machine by it.
    if (addr && /^127\.0\.0\.1:\d{1,5}$/.test(addr)) return addr;
  } catch {
    /* not installed, or not readable: the default port */
  }
  return DEFAULT_CONTROL;
}

function getJSON<T>(url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = net.request({ method: "GET", url });
    const timer = setTimeout(() => {
      req.abort();
      reject(new Error("timeout"));
    }, STATUS_TIMEOUT_MS);
    req.on("response", (res) => {
      let body = "";
      res.on("data", (c) => (body += c.toString()));
      res.on("end", () => {
        clearTimeout(timer);
        if (res.statusCode !== 200) return reject(new Error(`status ${res.statusCode}`));
        try {
          resolve(JSON.parse(body) as T);
        } catch (e) {
          reject(e as Error);
        }
      });
    });
    req.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    req.end();
  });
}

/** `http://127.0.0.1:8090` → `http://localhost:8090`: the name the console's
 *  session cookie and the dev server's origin allow-list both expect. */
export function asLocalhost(uiUrl: string): string {
  try {
    const u = new URL(uiUrl);
    if (u.hostname === "127.0.0.1") u.hostname = "localhost";
    return u.origin;
  } catch {
    return uiUrl;
  }
}

export async function applianceStatus(): Promise<ApplianceStatus> {
  const addr = await controlAddress();
  try {
    const w = await getJSON<WireStatus>(`http://${addr}/v1/status`);
    return {
      present: true,
      ready: w.ready,
      healthy: w.healthy,
      total: w.total,
      localUrl: asLocalhost(w.ui_url),
      lanUrl: w.lan_url,
      dataRoot: w.data_root,
      logDir: w.log_dir,
      version: w.version,
      processes: w.processes ?? [],
    };
  } catch (e) {
    return {
      present: false,
      ready: false,
      healthy: 0,
      total: 0,
      processes: [],
      reason: (e as Error).message,
    };
  }
}

/** One line for the tray and the launcher. */
export function describe(st: ApplianceStatus): string {
  if (!st.present) return "Server: not running on this computer";
  if (st.ready) return `Server: healthy (${st.healthy}/${st.total})`;
  const down = st.processes
    .filter((p) => !p.one_shot && p.critical && p.state !== "healthy")
    .map((p) => p.name);
  return down.length
    ? `Server: starting - waiting for ${down.join(", ")} (${st.healthy}/${st.total})`
    : `Server: starting (${st.healthy}/${st.total})`;
}

/** neubitvms-svc.exe as installed: resources\server beside the app. */
export function serviceExe(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "server", "neubitvms-svc.exe")
    : path.join(app.getAppPath(), "..", "dist", "vms-server", "neubitvms-svc.exe");
}

export type ServiceAction = "start" | "stop" | "restart";
export type { ServiceResult } from "@shared/ipc";

/** Start/stop/restart the service, elevated. A declined UAC prompt is
 *  "cancelled", not a failure: the operator chose not to. */
export function controlService(action: ServiceAction): Promise<ServiceResult> {
  if (process.platform !== "win32") return Promise.resolve("failed");
  const exe = serviceExe();
  const ps = path.join(
    process.env.SystemRoot ?? String.raw`C:\Windows`,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  // Start-Process -Verb RunAs raises the UAC prompt; -Wait returns its exit code.
  const script =
    `try { $p = Start-Process -FilePath '${exe.replaceAll("'", "''")}' -ArgumentList '${action}' ` +
    `-Verb RunAs -Wait -PassThru -WindowStyle Hidden; exit $p.ExitCode } ` +
    `catch { if ($_.Exception.NativeErrorCode -eq 1223) { exit 1223 }; exit 1 }`;
  return new Promise((resolve) => {
    execFile(
      ps,
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true },
      (err) => {
        const code = err
          ? ((err as NodeJS.ErrnoException & { code?: number }).code as unknown as number)
          : 0;
        if (code === 0) {
          log.info(`service ${action}: ok`);
          resolve("ok");
        } else if (code === 1223) {
          log.info(`service ${action}: UAC declined`);
          resolve("cancelled");
        } else {
          log.warn(`service ${action} failed: ${err?.message}`);
          resolve("failed");
        }
      },
    );
  });
}

const SERVICE_NAME = "NeubitVMS";

/** What the Service Control Manager says about NeubitVMS. `sc query` needs no
 *  elevation, and its exit code 1060 is the one reliable "not installed". */
export function serviceState(): Promise<LocalServerState["service"]> {
  if (process.platform !== "win32") return Promise.resolve("absent");
  const sc = path.join(
    process.env.SystemRoot ?? String.raw`C:\Windows`,
    "System32",
    "sc.exe",
  );
  return new Promise((resolve) => {
    execFile(
      sc,
      ["query", SERVICE_NAME],
      { windowsHide: true, timeout: 3_000 },
      (err, stdout) => {
        // execFile reports a non-zero exit as err.code (a number, despite the type).
        if (err && Number((err as { code?: unknown }).code) === 1060)
          return resolve("absent");
        const m = /STATE\s*:\s*\d+\s+(\w+)/.exec(stdout ?? "");
        switch (m?.[1]) {
          case "RUNNING":
            return resolve("running");
          case "STOPPED":
            return resolve("stopped");
          case "START_PENDING":
            return resolve("starting");
          default:
            return resolve(err ? "unknown" : "running");
        }
      },
    );
  });
}

/** The launcher's view of this machine's server: the SCM's word plus the
 *  control API's, so "installed but still starting" is never mistaken for "no
 *  server here". */
export async function localServerState(): Promise<LocalServerState> {
  const [service, st] = await Promise.all([serviceState(), applianceStatus()]);
  const longRunning = st.processes.filter((p) => !p.one_shot);
  return {
    // A control API answering without a registered service is a console-mode
    // run (a developer's); it is still this machine's server.
    service: service === "absent" && st.present ? "running" : service,
    bundled: serverBundled(),
    answering: st.present,
    ready: st.ready,
    healthy: st.healthy,
    total: st.total,
    waitingFor: longRunning
      .filter((p) => p.critical && p.state !== "healthy")
      .map((p) => p.name),
    failing: st.processes
      .filter((p) => p.state === "failed" || p.state === "restarting")
      .map((p) => ({ name: p.name, error: p.last_error ?? p.state })),
    logDir: st.logDir,
  };
}

/** Whether this install carries the server payload (the installer does; the
 *  Portable and a development run do not). */
export function serverBundled(): boolean {
  return process.platform === "win32" && app.isPackaged && existsSync(serviceExe());
}

/** Run install-appliance.ps1 again, elevated, in a window the operator can
 *  watch: the same idempotent setup the installer ran, for when that run did not
 *  finish. It is not waited for (a first setup takes minutes); the launcher
 *  polls the service instead, which appears once it is registered. */
export function repairServer(): Promise<ServiceResult> {
  if (!serverBundled()) return Promise.resolve("failed");
  const serverDir = path.dirname(serviceExe());
  const script = path.join(serverDir, "scripts", "install-appliance.ps1");
  const ps = path.join(
    process.env.SystemRoot ?? String.raw`C:\Windows`,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const q = (v: string): string => v.replaceAll("'", "''");
  const inner = `-NoProfile -ExecutionPolicy Bypass -NoExit -File "${script}" -ServerDir "${serverDir}"`;
  const launch =
    `try { Start-Process -FilePath '${q(ps)}' -ArgumentList '${q(inner)}' -Verb RunAs; exit 0 } ` +
    `catch { if ($_.Exception.NativeErrorCode -eq 1223) { exit 1223 }; exit 1 }`;
  return new Promise((resolve) => {
    execFile(ps, ["-NoProfile", "-NonInteractive", "-Command", launch], { windowsHide: true }, (err) => {
      const code = err ? Number((err as { code?: unknown }).code) : 0;
      if (code === 0) {
        log.info("server setup started (elevated)");
        resolve("ok");
      } else if (code === 1223) {
        log.info("server setup: UAC declined");
        resolve("cancelled");
      } else {
        log.warn(`server setup could not be started: ${err?.message}`);
        resolve("failed");
      }
    });
  });
}
