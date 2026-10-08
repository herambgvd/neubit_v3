import {
  normaliseConsoleUrl,
  type AppConfig,
  type ConsoleServer,
  type LocalServerState,
} from "@shared/ipc";

// The local launcher: the only UI this shell owns.
//
// It exists for two situations: a workstation install that has not been told
// which server to talk to, and a server machine whose own server is not ready
// yet (or is stopped). That one is waited for, not offered a picker. Everything after that is the console's job. So this stays a
// picker and does not grow into a settings app: shell preferences live in the tray
// menu, where an operator can reach them without leaving the console.

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`launcher: #${id} is missing from index.html`);
  return el as T;
};

const listEl = $<HTMLUListElement>("servers");
const savedHeading = $<HTMLHeadingElement>("saved-heading");
const formEl = $<HTMLFormElement>("add");
const labelEl = $<HTMLInputElement>("label");
const urlEl = $<HTMLInputElement>("url");
const statusEl = $<HTMLParagraphElement>("status");
const testEl = $<HTMLButtonElement>("test");
const connectEl = $<HTMLButtonElement>("connect");
const versionEl = $<HTMLElement>("version");

function say(message: string, tone: "" | "good" | "bad" = ""): void {
  statusEl.textContent = message;
  statusEl.className = tone ? `status ${tone}` : "status";
}

function renderServers(cfg: AppConfig): void {
  listEl.replaceChildren();
  savedHeading.hidden = cfg.servers.length === 0;

  for (const server of cfg.servers) {
    const li = document.createElement("li");

    const open = document.createElement("button");
    open.className = "server";
    open.type = "button";
    open.addEventListener("click", () => void window.neubit.openServer(server.id));

    const meta = document.createElement("span");
    meta.className = "meta";

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = server.label;

    const url = document.createElement("span");
    url.className = "url";
    url.textContent = server.url;

    meta.append(name, url);

    const drop = document.createElement("button");
    drop.className = "drop";
    drop.type = "button";
    drop.title = `Forget ${server.label}`;
    drop.setAttribute("aria-label", `Forget ${server.label}`);
    drop.textContent = "×";
    // stopPropagation, or removing a server also opens it — the delete button
    // lives inside the button that connects.
    drop.addEventListener("click", (e) => {
      e.stopPropagation();
      void window.neubit.removeServer(server.id).then(renderServers);
    });

    open.append(meta);
    li.append(open, drop);
    // The row is the clickable button plus its own delete affordance, laid out
    // together rather than nested — a button inside a button is invalid HTML and
    // browsers resolve it by dropping one of them.
    li.style.display = "flex";
    li.style.gap = "0.35rem";
    li.style.alignItems = "stretch";
    listEl.append(li);
  }
}

/** Resolve what is in the address box, reporting the reason when it will not do.
 *  Shared by Test and Connect so the two can never disagree about what is valid. */
function resolveInput(): string | null {
  const check = normaliseConsoleUrl(urlEl.value);
  if (!check.ok || !check.url) {
    say(check.reason ?? "That address cannot be used.", "bad");
    return null;
  }
  return check.url;
}

async function testConnection(): Promise<void> {
  const url = resolveInput();
  if (!url) return;

  testEl.disabled = true;
  say(`Contacting ${url}...`);
  try {
    const status = await window.neubit.probeServer(url);
    if (status.reachable) {
      say(`Reachable — answered in ${status.latencyMs} ms.`, "good");
    } else {
      say(status.reason ?? "Not reachable.", "bad");
    }
  } finally {
    testEl.disabled = false;
  }
}

async function connect(): Promise<void> {
  const url = resolveInput();
  if (!url) return;

  connectEl.disabled = true;
  say(`Contacting ${url}...`);
  try {
    // Probed before saving, deliberately. Storing an unreachable server would add
    // its origin to the navigation allow-list and then load a window that never
    // paints, which reads as the app hanging rather than as a wrong address.
    const status = await window.neubit.probeServer(url);
    if (!status.reachable) {
      say(status.reason ?? "Not reachable.", "bad");
      return;
    }

    const server: ConsoleServer = {
      // Keyed by origin, so re-adding the same server updates it rather than
      // stacking a second entry pointing at the same place.
      id: url,
      label: labelEl.value.trim() || new URL(url).host,
      url,
    };
    await window.neubit.upsertServer(server);
    await window.neubit.openServer(server.id);
  } finally {
    connectEl.disabled = false;
  }
}

testEl.addEventListener("click", () => void testConnection());
formEl.addEventListener("submit", (e) => {
  e.preventDefault();
  void connect();
});

// ── The server on this machine, when it is not ready yet ──
//
// Right after an install, or after a reboot, the app can open before the
// server's first start finishes (it creates the database). The start-up probe
// then finds nothing, and offering "Add a server" on the machine that IS the
// server reads as a failed install. So when the NeubitVMS service is installed
// here, wait for it, say how far it has got, and open its console the moment it
// is ready. Same shape as the NVR launcher's wait.

const checkingEl = $<HTMLParagraphElement>("checking");
const pickerEl = $<HTMLDivElement>("picker");
const ledeEl = $<HTMLParagraphElement>("lede");
const waitingEl = $<HTMLElement>("waiting");
const waitTitleEl = $<HTMLParagraphElement>("waitTitle");
const waitTextEl = $<HTMLParagraphElement>("waitText");
const waitBarEl = $<HTMLDivElement>("waitBar");
const waitDetailEl = $<HTMLParagraphElement>("waitDetail");
const waitClockEl = $<HTMLParagraphElement>("waitClock");
const startEl = $<HTMLButtonElement>("startServer");
const repairEl = $<HTMLButtonElement>("repairServer");
const usePickerEl = $<HTMLButtonElement>("usePicker");
const useLocalEl = $<HTMLButtonElement>("useLocal");

const POLL_MS = 2_000;
/** The installer's own ready timeout: past it, a start is not merely slow. */
const SLOW_MS = 15 * 60_000;
/** A running service whose control API has not answered for this long is stuck. */
const SILENT_MS = 90_000;
const INSTALL_LOG = String.raw`C:\ProgramData\Neubit\vms-install.log`;

const PICKER_LEDE = "Connect this workstation to a Neubit VMS server.";
const WAIT_LEDE = "This computer runs the Neubit VMS server.";

let waitTimer: number | undefined;
let waitStarted = 0;
let localInstalled = false;
/** The operator started the setup again; the service is not registered yet. */
let repairing = false;

function elapsedLabel(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `Waiting ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function stopPolling(): void {
  if (waitTimer !== undefined) window.clearTimeout(waitTimer);
  waitTimer = undefined;
}

async function showPicker(): Promise<void> {
  stopPolling();
  checkingEl.hidden = true;
  waitingEl.hidden = true;
  pickerEl.hidden = false;
  ledeEl.textContent = PICKER_LEDE;
  useLocalEl.hidden = !localInstalled;
  renderServers(await window.neubit.getConfig());
  urlEl.focus();
}

function setWait(title: string, text: string, bad = false): void {
  waitTitleEl.textContent = title;
  waitTextEl.textContent = text;
  waitTextEl.className = bad ? "wait-text bad" : "wait-text";
}

/** One line on what the server is doing: progress, what it waits for, what fails. */
function progressLine(st: LocalServerState): string {
  const parts = [`${st.healthy}/${st.total} running`];
  if (st.waitingFor.length) parts.push(`waiting for ${st.waitingFor.join(", ")}`);
  for (const f of st.failing) parts.push(`${f.name}: ${f.error}`);
  return parts.join(" · ");
}

function logsHint(st: LocalServerState): string {
  return st.logDir ? ` The server's logs are in ${st.logDir}.` : "";
}

/** Render one reading. Returns false once the wait is over (ready, or gone). */
function renderLocal(st: LocalServerState, elapsed: number): boolean {
  startEl.hidden = st.service !== "stopped";
  repairEl.hidden = !(st.service === "absent" && st.bundled && !repairing);
  waitBarEl.style.width = st.total ? `${Math.round((st.healthy / st.total) * 100)}%` : "0";
  waitDetailEl.textContent = st.answering ? progressLine(st) : "";

  if (st.ready) {
    setWait("The server is ready. Opening the console…", "");
    void window.neubit.openLocalServer();
    return false;
  }
  if (st.service === "absent" && st.bundled) {
    // Installed WITH the server, yet no service: the installer's server setup
    // did not finish. Keep polling, so a repair in progress is picked up.
    if (repairing) {
      setWait(
        "Setting up the server on this computer…",
        "Follow the progress in the PowerShell window. This screen moves on by itself.",
      );
    } else {
      setWait(
        "The server on this computer is not set up.",
        `The installer could not finish setting it up. The reason is at the end of ${INSTALL_LOG}. ` +
          "Set it up again here (Windows asks for permission, and a window shows the progress), " +
          "or connect to a different server.",
        true,
      );
    }
    return true;
  }
  if (st.service === "absent") {
    void showPicker();
    return false;
  }
  if (st.service === "stopped") {
    setWait(
      "The Neubit VMS server on this computer is stopped.",
      "Start it here (Windows asks for permission), or start NeubitVMS in Windows Services.",
      true,
    );
    return true;
  }
  if (!st.answering && elapsed >= SILENT_MS) {
    setWait(
      "The server is running but not answering.",
      `If this does not change, restart NeubitVMS in Windows Services. The install log is ${INSTALL_LOG}.`,
      true,
    );
    return true;
  }
  if (elapsed >= SLOW_MS) {
    setWait(
      "The server is taking longer to start than it should.",
      "It keeps trying on its own. Check what it is waiting for below." + logsHint(st),
      true,
    );
    return true;
  }
  setWait(
    "Starting the Neubit VMS server on this computer…",
    "Its console opens by itself as soon as it is ready. The first start after installation " +
      "creates the database and can take a few minutes.",
  );
  return true;
}

function waitForLocalServer(): void {
  stopPolling();
  waitStarted = Date.now();
  checkingEl.hidden = true;
  pickerEl.hidden = true;
  waitingEl.hidden = false;
  ledeEl.textContent = WAIT_LEDE;

  const tick = async (): Promise<void> => {
    const st = await window.neubit.localServer().catch(() => null);
    if (waitingEl.hidden) return; // the operator chose the picker meanwhile
    const elapsed = Date.now() - waitStarted;
    if (st && !renderLocal(st, elapsed)) return;
    waitClockEl.textContent = elapsedLabel(elapsed);
    waitTimer = window.setTimeout(() => void tick(), POLL_MS);
  };
  void tick();
}

startEl.addEventListener("click", () => {
  startEl.disabled = true;
  void window.neubit
    .startLocalServer()
    .then((result) => {
      if (result === "cancelled") {
        setWait(
          "The server was not started.",
          "Windows asked for permission and it was declined.",
          true,
        );
      } else if (result === "failed") {
        setWait(
          "The server could not be started.",
          "Start NeubitVMS in Windows Services to see the reason, or reinstall.",
          true,
        );
      } else {
        waitForLocalServer();
      }
    })
    .finally(() => {
      startEl.disabled = false;
    });
});
repairEl.addEventListener("click", () => {
  repairEl.disabled = true;
  void window.neubit
    .repairLocalServer()
    .then((result) => {
      if (result === "ok") {
        repairing = true;
        waitForLocalServer();
      } else if (result === "cancelled") {
        setWait("The server was not set up.", "Windows asked for permission and it was declined.", true);
      } else {
        setWait(
          "The setup could not be started.",
          String.raw`Run resources\server\scripts\install-appliance.ps1 from an elevated PowerShell.`,
          true,
        );
      }
    })
    .finally(() => {
      repairEl.disabled = false;
    });
});
usePickerEl.addEventListener("click", () => void showPicker());
useLocalEl.addEventListener("click", () => waitForLocalServer());

// First paint.
void (async () => {
  const info = await window.neubit.appInfo();
  versionEl.textContent = `Neubit VMS ${info.version} · Electron ${info.electron} · ${info.platform}`;

  // This machine's own server first: installed here means wait for it.
  const local = await window.neubit.localServer().catch(() => null);
  localInstalled = !!local && (local.service !== "absent" || local.bundled);
  if (localInstalled) {
    waitForLocalServer();
    return;
  }

  await showPicker();
  // A hint rather than a default value: pre-filling the box would make Connect
  // look safe to press on a workstation that has no local server, and the probe
  // failure that followed would read as a broken app.
  const docker = await window.neubit.probeServer("127.0.0.1");
  if (docker.reachable) {
    say("A Neubit server is running on this machine — leave the address empty to use it.");
    urlEl.value = "127.0.0.1";
    labelEl.value = "This machine";
  }
})();
