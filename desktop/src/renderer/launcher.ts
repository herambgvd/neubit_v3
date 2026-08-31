import { normaliseConsoleUrl, type AppConfig, type ConsoleServer } from "@shared/ipc";

// The local launcher: the only UI this shell owns.
//
// It exists for one situation — a workstation install that has not been told which
// server to talk to. Everything after that is the console's job. So this stays a
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

// First paint.
void (async () => {
  renderServers(await window.neubit.getConfig());

  const info = await window.neubit.appInfo();
  versionEl.textContent = `Neubit VMS ${info.version} · Electron ${info.electron} · ${info.platform}`;

  // A hint rather than a default value: pre-filling the box would make Connect
  // look safe to press on a workstation that has no local server, and the probe
  // failure that followed would read as a broken app.
  const local = await window.neubit.probeServer("127.0.0.1");
  if (local.reachable) {
    say("A Neubit server is running on this machine — leave the address empty to use it.");
    urlEl.value = "127.0.0.1";
    labelEl.value = "This machine";
  }

  urlEl.focus();
})();
