import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { adminApi } from "@/lib/api";
import type { PlatformModule } from "@/lib/types";
import { renderWithProviders } from "@/test/render";

import ModulesPage from "./page";

function mod(over: Partial<PlatformModule> = {}): PlatformModule {
  return {
    id: "m1",
    key: "vms",
    name: "Video",
    description: "Cameras, NVR and streaming",
    category: "surveillance",
    default_enabled: true,
    is_system: false,
    ...over,
  };
}

beforeEach(() => {
  vi.spyOn(adminApi, "listModules").mockImplementation(async () => [mod()]);
});

describe("module catalog", () => {
  it("lists a module with its key, category and default", async () => {
    renderWithProviders(<ModulesPage />);
    await screen.findByText("Video");
    const table = within(screen.getByRole("table"));

    expect(table.getByText("vms")).toBeInTheDocument();
    expect(table.getByText("surveillance")).toBeInTheDocument();
    expect(table.getByText("On")).toBeInTheDocument();
    expect(table.getByText("Custom")).toBeInTheDocument();
  });

  // System modules are seeded by core; deleting one would leave tenants holding
  // a feature flag with nothing behind it.
  it("will not let a system module be deleted", async () => {
    vi.spyOn(adminApi, "listModules").mockImplementation(async () => [mod({ is_system: true })]);

    renderWithProviders(<ModulesPage />);
    await screen.findByText("Video");

    expect(screen.getByRole("button", { name: /delete/i })).toBeDisabled();
    expect(screen.getByText("System")).toBeInTheDocument();
  });

  it("confirms before deleting a custom module", async () => {
    const deleteModule = vi.spyOn(adminApi, "deleteModule");

    renderWithProviders(<ModulesPage />);
    await userEvent.click(await screen.findByRole("button", { name: /delete/i }));

    expect(await screen.findByText(/removed from the catalog/i)).toBeInTheDocument();
    expect(deleteModule).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: /^delete$/i }));

    await waitFor(() => expect(deleteModule).toHaveBeenCalledWith("vms"));
  });

  it("locks the key when editing — the key is the tenant-side identity", async () => {
    renderWithProviders(<ModulesPage />);
    await userEvent.click(await screen.findByRole("button", { name: /edit/i }));

    expect(await screen.findByDisplayValue("vms")).toBeDisabled();
    expect(screen.getByDisplayValue("Video")).toBeEnabled();
  });

  it("creates a module with the trimmed key and the default toggle", async () => {
    const createModule = vi.spyOn(adminApi, "createModule").mockResolvedValue(mod());

    renderWithProviders(<ModulesPage />);
    await userEvent.click(await screen.findByRole("button", { name: /add module/i }));
    await userEvent.type(await screen.findByPlaceholderText("video_analytics"), " anpr ");
    await userEvent.type(screen.getByPlaceholderText("Video Analytics"), "ANPR");
    await userEvent.click(screen.getByRole("button", { name: /^add module$/i }));

    await waitFor(() =>
      expect(createModule).toHaveBeenCalledWith(
        expect.objectContaining({ key: "anpr", name: "ANPR", default_enabled: true })
      )
    );
  });

  it("filters on key, name and category", async () => {
    vi.spyOn(adminApi, "listModules").mockImplementation(async () => [
      mod(),
      mod({ id: "m2", key: "access", name: "Access Control", category: "physical" }),
    ]);

    renderWithProviders(<ModulesPage />);
    await screen.findByText("Access Control");

    await userEvent.type(screen.getByPlaceholderText(/search key, name or category/i), "physical");

    await waitFor(() => expect(screen.queryByText("Video")).not.toBeInTheDocument());
    expect(screen.getByText("Access Control")).toBeInTheDocument();
  });
});
