import { net } from "electron";
import { CONSOLE_PORT, type ServerStatus } from "@shared/ipc";
import { log } from "./logger";

// Is there a v3 console at this origin, and is it actually working?
//
// This is the v3 counterpart of the NVR shell's appliance.ts, and it is much
// smaller on purpose. The NVR shell supervises a Windows Service on the same box
// — start, stop, restart, elevation, log tailing — because a recorder that has
// stopped is the operator's problem to fix from the console. v3's server-side
// supervision belongs to P2's installer and the service it registers; until that
// exists there is nothing for the shell to supervise, and inventing a half of it
// now would be a contract to maintain with nothing behind it.
//
// What the shell does need is the honest answer to one question: can I load a
// console from here? That is what this file answers.

/** How long to wait before calling an origin unreachable.
 *
 *  Short, because this runs on the path to the first window: a workstation whose
 *  server is switched off must reach the picker in a moment, not sit on a blank
 *  frame. A server that is up answers /health in single-digit milliseconds on a
 *  LAN; one that needs longer than this is not in a state the operator should be
 *  dropped into without being told. */
const PROBE_TIMEOUT_MS = 2_500;

/** The origin a v3 appliance serves on this machine.
 *
 *  Port 80 — the gateway — because that is the only origin where the console's
 *  relative API base resolves. See CONSOLE_PORT in shared/ipc.ts for what happens
 *  when it is not.
 *
 *  ══ AND `localhost`, NOT `127.0.0.1` ════════════════════════════════════════
 *
 *  They are the same machine and not the same origin, and the difference is
 *  visible. Next's dev server refuses cross-site requests for `/_next/*` unless
 *  the Origin is allow-listed (`allowedDevOrigins` in frontend/next.config.js),
 *  and `127.0.0.1` is not one of the names it accepts by default:
 *
 *      Origin http://localhost   -> 200
 *      Origin http://127.0.0.1   -> 403
 *
 *  The failure is quiet and easy to misread. The server-rendered HTML arrives, so
 *  the login page's branding panel paints normally; the client bundle 403s, so the
 *  page never hydrates, and every mount-animated element — the sign-in card among
 *  them — stays at opacity 0. What the operator sees is half a login screen and no
 *  error anywhere. That is exactly how the first run of this shell looked.
 *
 *  `frontend/next.config.js` now allow-lists `127.0.0.1` too, so both work; the
 *  shell still asks for `localhost` because it is the name the dev server has
 *  always trusted and the one a human would type. */
export const LOCAL_CONSOLE_URL =
  CONSOLE_PORT === 80 ? "http://localhost" : `http://localhost:${CONSOLE_PORT}`;

/** Probe `<origin>/health`.
 *
 *  /health is core's, routed there by Traefik, so a 200 means the whole path the
 *  console depends on is up: the gateway is routing, core is running, and its
 *  database answered. A 200 from the Next server alone cannot be mistaken for
 *  this — Next has no /health route, which is the same asymmetry that makes the
 *  gateway origin the only correct one to load.
 *
 *  Uses Electron's `net` rather than `fetch` so the request goes through Chromium's
 *  stack with the app's proxy settings, exactly as the window's own load will. */
export function probe(origin: string): Promise<ServerStatus> {
  return new Promise((resolve) => {
    let settled = false;
    const started = Date.now();

    const done = (status: ServerStatus) => {
      if (settled) return;
      settled = true;
      resolve(status);
    };

    let request: Electron.ClientRequest;
    try {
      request = net.request({ method: "GET", url: `${origin}/health` });
    } catch (e) {
      done({ url: origin, reachable: false, reason: (e as Error).message });
      return;
    }

    const timer = setTimeout(() => {
      request.abort();
      done({
        url: origin,
        reachable: false,
        reason: `No answer within ${PROBE_TIMEOUT_MS / 1000}s.`,
      });
    }, PROBE_TIMEOUT_MS);

    request.on("response", (response) => {
      clearTimeout(timer);
      // Drain: an undrained response keeps the socket open and Electron warns.
      response.on("data", () => {});
      response.on("end", () => {});

      const code = response.statusCode;
      if (code === 200) {
        done({ url: origin, reachable: true, latencyMs: Date.now() - started });
      } else {
        done({
          url: origin,
          reachable: false,
          reason: `The server answered ${code} — this may not be a Neubit console.`,
        });
      }
    });

    request.on("error", (e) => {
      clearTimeout(timer);
      done({ url: origin, reachable: false, reason: connectionReason(e) });
    });

    request.end();
  });
}

/** Turn Chromium's network error text into something an operator can act on.
 *  The raw strings ("net::ERR_CONNECTION_REFUSED") are accurate and useless to
 *  the person reading them. */
function connectionReason(e: Error): string {
  const m = e.message ?? "";
  if (/ERR_CONNECTION_REFUSED/i.test(m)) {
    return "Nothing is listening there. Is the Neubit server running?";
  }
  if (/ERR_NAME_NOT_RESOLVED/i.test(m)) return "That host name could not be found.";
  if (/ERR_CONNECTION_TIMED_OUT/i.test(m)) {
    return "The server did not answer. Check the address and the network.";
  }
  if (/ERR_ADDRESS_UNREACHABLE|ERR_NETWORK/i.test(m)) return "That address is unreachable.";
  return m || "The server could not be reached.";
}

/** Whether this machine is running a v3 appliance. */
export async function probeLocal(): Promise<ServerStatus> {
  const status = await probe(LOCAL_CONSOLE_URL);
  log.info(
    status.reachable
      ? `local console reachable at ${LOCAL_CONSOLE_URL} (${status.latencyMs}ms)`
      : `no local console: ${status.reason}`,
  );
  return status;
}
