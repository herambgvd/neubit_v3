import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { adminApi } from "@/lib/api";
import type { Container } from "@/lib/types";
import { renderWithProviders } from "@/test/render";

import InfrastructurePage from "./page";

function container(over: Partial<Container> = {}): Container {
  return {
    name: "neubit-core",
    id: "abc123",
    image: "neubit/core:latest",
    state: "running",
    status: "running",
    health: "healthy",
    created_at: new Date(Date.now() - 3_600_000).toISOString(),
    service: "core",
    cpu_pct: 12.5,
    mem_used_mb: 512,
    mem_limit_mb: 2048,
    ...over,
  };
}

beforeEach(() => {
  vi.spyOn(adminApi, "listContainers").mockImplementation(async () => [container()]);
  vi.spyOn(adminApi, "infraHost").mockResolvedValue({
    containers_running: 1,
    containers_total: 1,
    cpu_count: 8,
    mem_used_mb: 4096,
    mem_total_mb: 16384,
  });
});

describe("infrastructure fleet", () => {
  it("shows a container's state, cpu and memory", async () => {
    renderWithProviders(<InfrastructurePage />);
    await screen.findByText("neubit-core");
    const table = within(screen.getByRole("table"));

    expect(table.getByText("12.5%")).toBeInTheDocument();
    expect(table.getByText("512 MB / 2.0 GB")).toBeInTheDocument();
    expect(table.getByText(/running/i)).toBeInTheDocument();
  });

  // Stopping a container can take dependent services down with it.
  it("confirms before stopping, and stops on confirm", async () => {
    const stopContainer = vi
      .spyOn(adminApi, "stopContainer")
      .mockResolvedValue({ ok: true, detail: null });

    renderWithProviders(<InfrastructurePage />);
    await userEvent.click(await screen.findByRole("button", { name: /^stop$/i }));

    expect(await screen.findByText(/dependent services may be affected/i)).toBeInTheDocument();
    expect(stopContainer).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: /stop container/i }));

    await waitFor(() => expect(stopContainer).toHaveBeenCalledWith("neubit-core"));
  });

  it("restarts without a confirmation — it is recoverable", async () => {
    const restartContainer = vi
      .spyOn(adminApi, "restartContainer")
      .mockResolvedValue({ ok: true, detail: null });

    renderWithProviders(<InfrastructurePage />);
    await userEvent.click(await screen.findByRole("button", { name: /restart/i }));

    await waitFor(() => expect(restartContainer).toHaveBeenCalledWith("neubit-core"));
  });

  it("offers Start, not Stop, for a container that is already down", async () => {
    vi.spyOn(adminApi, "listContainers").mockImplementation(async () => [
      container({ state: "exited", health: null, cpu_pct: null, mem_used_mb: null }),
    ]);

    renderWithProviders(<InfrastructurePage />);
    await screen.findByText("neubit-core");

    expect(screen.getByRole("button", { name: /^start$/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^stop$/i })).not.toBeInTheDocument();
  });

  it("counts an unhealthy container in the summary", async () => {
    vi.spyOn(adminApi, "listContainers").mockImplementation(async () => [
      container({ health: "unhealthy" }),
    ]);

    renderWithProviders(<InfrastructurePage />);

    expect(await screen.findByText("1 unhealthy")).toBeInTheDocument();
  });

  it("filters by name", async () => {
    vi.spyOn(adminApi, "listContainers").mockImplementation(async () => [
      container(),
      container({ name: "neubit-vision", id: "def456", image: "neubit/vision:latest" }),
    ]);

    renderWithProviders(<InfrastructurePage />);
    await screen.findByText("neubit-vision");

    await userEvent.type(screen.getByPlaceholderText(/filter by name or image/i), "vision");

    await waitFor(() => expect(screen.queryByText("neubit-core")).not.toBeInTheDocument());
    expect(screen.getByText("neubit-vision")).toBeInTheDocument();
  });

  // The backend answers 501 for scaling; the UI must report that, not fake a win.
  it("reports a refused scale instead of claiming success", async () => {
    vi.spyOn(adminApi, "scaleService").mockResolvedValue({
      ok: false,
      detail: "scaling 'core' is not implemented",
    });

    renderWithProviders(<InfrastructurePage />);
    await userEvent.click(await screen.findByRole("button", { name: /scale service/i }));
    await userEvent.type(screen.getByPlaceholderText("service name"), "core");
    await userEvent.click(screen.getByRole("button", { name: /^scale$/i }));

    await waitFor(() => expect(adminApi.scaleService).toHaveBeenCalledWith("core", 1));
    // The inline form stays open, because nothing was applied.
    expect(screen.getByPlaceholderText("service name")).toBeInTheDocument();
  });

  it("opens the log drawer for the clicked container", async () => {
    vi.spyOn(adminApi, "containerLogs").mockResolvedValue({
      lines: ["2026-01-02T03:04:05Z INFO ready", "2026-01-02T03:04:06Z ERROR boom"],
    });

    renderWithProviders(<InfrastructurePage />);
    await userEvent.click(await screen.findByText("neubit/core:latest"));

    expect(await screen.findByText(/tailing container logs/i)).toBeInTheDocument();
    expect(await screen.findByText(/INFO ready/)).toBeInTheDocument();
    await waitFor(() => expect(adminApi.containerLogs).toHaveBeenCalledWith("neubit-core", 200));
  });
});
