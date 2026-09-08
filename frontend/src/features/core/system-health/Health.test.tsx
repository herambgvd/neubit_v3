/**
 * Health — the estate view.
 *
 * The page's job is to say which services are running and let an operator read
 * what one of them is printing. The claims worth pinning are the ones that would
 * mislead an operator at 2am:
 *   * a failed inventory must not read as "nothing is running";
 *   * logs are gated separately from status, and the pane says so rather than
 *     showing an empty console;
 *   * restart is a super-admin action and is not offered to anyone else;
 *   * a following tail asks for what is NEW, not the whole tail again.
 */
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { httpError, stubApi, type ApiStub } from "@/test/apiStub";
import { renderWithProviders } from "@/test/render";

import HealthPage from "./Health";

const auth = { perms: ["system.read", "system.logs"], superadmin: false };

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    user: { id: "me", is_superadmin: auth.superadmin },
    can: (p: string) => auth.perms.includes(p),
    hasModule: () => true,
  }),
}));

const SERVICES = [
  {
    name: "vision", container: "neubit-v3-vision-1", state: "exited", health: null,
    running: false, created_at: "2026-01-01T00:00:00Z",
    cpu_pct: null, mem_used_mb: null, mem_limit_mb: null,
  },
  {
    name: "core", container: "neubit-v3-core-1", state: "running", health: "healthy",
    running: true, created_at: "2026-01-01T00:00:00Z",
    cpu_pct: 3.5, mem_used_mb: 210, mem_limit_mb: 2048,
  },
];

const HEALTH = { status: "healthy", checks: { database: "ok", redis: "ok", storage: "ok" } };
const RESOURCES = { cpu_percent: 12, ram: { percent: 40, used: 1e9, total: 4e9 }, disk: { percent: 55, used: 1e10, total: 2e10 }, gpus: [] };

let stub: ApiStub;

function stubAll(over: Record<string, unknown> = {}) {
  stub = stubApi({
    "GET /system/health": HEALTH,
    "GET /system/resources": RESOURCES,
    "GET /system/services": SERVICES,
    "GET /system/services/neubit-v3-vision-1/logs": {
      lines: ["2026-01-10T12:00:01Z ERROR could not connect"],
    },
    "GET /system/services/neubit-v3-core-1/logs": { lines: ["2026-01-10T12:00:02Z INFO ok"] },
    ...over,
  });
  return stub;
}

beforeEach(() => {
  auth.perms = ["system.read", "system.logs"];
  auth.superadmin = false;
  stubAll();
});

describe("the estate", () => {
  it("lists the services and opens the one needing attention first", async () => {
    renderWithProviders(<HealthPage />);
    expect(await screen.findAllByText("vision")).not.toHaveLength(0);
    expect(screen.getByText("core")).toBeInTheDocument();
    // The server orders trouble first; the page opens whatever is first, so the
    // pane lands on the broken service rather than on an alphabetical one.
    expect(await screen.findByRole("log", { name: /vision logs/i })).toBeInTheDocument();
  });

  it("says the inventory is unavailable instead of showing an empty estate", async () => {
    // An unreachable ops-agent rendering as zero services would tell an operator
    // the deployment is down when it is the watcher that is down.
    stubAll({ "GET /system/services": () => httpError(503, "ops-agent unreachable") });
    renderWithProviders(<HealthPage />);

    expect(await screen.findByText(/service inventory unavailable/i)).toBeInTheDocument();
    expect(screen.queryByText(/no services reported/i)).toBeNull();
  });

  it("shows a failing dependency's own message, not just 'down'", async () => {
    stubAll({
      "GET /system/health": {
        status: "degraded",
        checks: { database: "ok", redis: "error: connection refused", storage: "ok" },
      },
    });
    renderWithProviders(<HealthPage />);
    expect(await screen.findByText(/error: connection refused/i)).toBeInTheDocument();
  });
});

describe("logs", () => {
  it("reads the selected service's tail and asks for only new lines after that", async () => {
    renderWithProviders(<HealthPage />);
    await screen.findByRole("log", { name: /vision logs/i });

    await waitFor(() =>
      expect(stub.matching("GET /system/services/neubit-v3-vision-1/logs")).not.toHaveLength(0),
    );
    const first = stub.matching("GET /system/services/neubit-v3-vision-1/logs")[0];
    // The first read has no lower bound; the follow-up carries the timestamp of
    // the newest line held, or every poll re-fetches the whole tail.
    expect(first.params?.since).toBe(0);
    await waitFor(
      () => {
        const calls = stub.matching("GET /system/services/neubit-v3-vision-1/logs");
        expect(calls.length).toBeGreaterThan(1);
        expect(calls[calls.length - 1].params?.since).toBeGreaterThan(0);
      },
      { timeout: 6000 },
    );
  }, 10000);

  it("switches the tail when another service is picked", async () => {
    renderWithProviders(<HealthPage />);
    await screen.findByRole("log", { name: /vision logs/i });

    await userEvent.click(screen.getByText("core"));
    expect(await screen.findByRole("log", { name: /core logs/i })).toBeInTheDocument();
    expect(await screen.findByText(/INFO ok/)).toBeInTheDocument();
    // vision's line must not still be on screen under core's name.
    expect(screen.queryByText(/could not connect/)).toBeNull();
  });

  it("explains the missing grant rather than showing an empty console", async () => {
    auth.perms = ["system.read"];
    renderWithProviders(<HealthPage />);
    await screen.findAllByText("vision");

    expect(await screen.findByText(/read service logs/i)).toBeInTheDocument();
    // And it does not call an endpoint it knows will 403.
    expect(stub.matching("GET /system/services/neubit-v3-vision-1/logs")).toHaveLength(0);
  });

  it("stops polling when following is paused", async () => {
    renderWithProviders(<HealthPage />);
    await screen.findByRole("log", { name: /vision logs/i });
    await userEvent.click(screen.getByRole("button", { name: /pause following/i }));

    const seen = stub.matching("GET /system/services/neubit-v3-vision-1/logs").length;
    await new Promise((r) => setTimeout(r, 4000));
    expect(stub.matching("GET /system/services/neubit-v3-vision-1/logs")).toHaveLength(seen);
  }, 10000);
});

describe("restart", () => {
  it("is not offered to an operator who is not a super-admin", async () => {
    renderWithProviders(<HealthPage />);
    await screen.findAllByText("vision");
    expect(screen.queryByRole("button", { name: /restart/i })).toBeNull();
  });

  it("asks before restarting, and posts to the audited infra route", async () => {
    auth.superadmin = true;
    stubAll({ "POST /admin/infra/containers/neubit-v3-vision-1/restart": { ok: true } });
    renderWithProviders(<HealthPage />);
    await screen.findAllByText("vision");

    await userEvent.click(screen.getByRole("button", { name: /restart/i }));
    // A restart interrupts whatever the service is serving — never one click.
    expect(await screen.findByText(/restart service\?/i)).toBeInTheDocument();
    expect(stub.matching("POST /admin/infra/containers/neubit-v3-vision-1/restart")).toHaveLength(0);

    await userEvent.click(screen.getAllByRole("button", { name: /^restart$/i }).at(-1)!);
    await waitFor(() =>
      expect(stub.matching("POST /admin/infra/containers/neubit-v3-vision-1/restart")).toHaveLength(1),
    );
  });
});
