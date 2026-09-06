import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { adminApi } from "@/lib/api";
import { renderWithProviders } from "@/test/render";

import DatabasePage from "./page";

beforeEach(() => {
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: vi.fn(() => "blob:mock"),
    revokeObjectURL: vi.fn(),
  });
});

async function choose(file: File) {
  await userEvent.click(screen.getByRole("button", { name: /choose file/i }));
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  await userEvent.upload(input, file);
}

const dump = () => new File(["-- sql"], "control.sql", { type: "application/sql" });

describe("database restore", () => {
  it("cannot start without a file", async () => {
    renderWithProviders(<DatabasePage />);

    expect(screen.getByRole("button", { name: /restore database/i })).toBeDisabled();
  });

  it("refuses a file that is not a .sql dump", async () => {
    renderWithProviders(<DatabasePage />);
    await choose(new File(["nope"], "photo.png", { type: "image/png" }));

    expect(screen.getByText(/no file selected/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /restore database/i })).toBeDisabled();
  });

  // The restore drops and recreates tables. Typing the word is the last gate
  // before that, so it must actually gate.
  it("requires the confirmation word before it will run", async () => {
    const importDatabase = vi.spyOn(adminApi, "importDatabase");

    renderWithProviders(<DatabasePage />);
    await choose(dump());
    await userEvent.click(screen.getByRole("button", { name: /restore database/i }));

    const confirm = await screen.findByRole("button", { name: /restore now/i });
    expect(confirm).toBeDisabled();

    await userEvent.type(screen.getByPlaceholderText("RESTORE"), "restore please");
    expect(confirm).toBeDisabled();
    expect(importDatabase).not.toHaveBeenCalled();
  });

  it("runs once the word matches, and uploads the chosen file", async () => {
    const file = dump();
    const importDatabase = vi
      .spyOn(adminApi, "importDatabase")
      .mockResolvedValue({ ok: true, exit_code: 0, output: "" });
    vi.spyOn(adminApi, "logout").mockResolvedValue();

    renderWithProviders(<DatabasePage />);
    await choose(file);
    await userEvent.click(screen.getByRole("button", { name: /restore database/i }));
    await userEvent.type(await screen.findByPlaceholderText("RESTORE"), "restore");
    await userEvent.click(screen.getByRole("button", { name: /restore now/i }));

    await waitFor(() => expect(importDatabase).toHaveBeenCalledWith(file));
    // The restore replaced the users table, so the session must not be kept.
    expect(adminApi.logout).toHaveBeenCalled();
  });

  it("reports a restore that came back not-ok instead of claiming success", async () => {
    vi.spyOn(adminApi, "importDatabase").mockResolvedValue({
      ok: false,
      exit_code: 3,
      output: "ERROR: could not acquire lock",
    });
    const logout = vi.spyOn(adminApi, "logout").mockResolvedValue();

    renderWithProviders(<DatabasePage />);
    await choose(dump());
    await userEvent.click(screen.getByRole("button", { name: /restore database/i }));
    await userEvent.type(await screen.findByPlaceholderText("RESTORE"), "RESTORE");
    await userEvent.click(screen.getByRole("button", { name: /restore now/i }));

    expect(await screen.findByText(/restore failed \(exit 3\)/i)).toBeInTheDocument();
    expect(screen.getByText(/could not acquire lock/i)).toBeInTheDocument();
    expect(logout).not.toHaveBeenCalled();
  });

  it("downloads a dated backup on export", async () => {
    const exportDatabase = vi
      .spyOn(adminApi, "exportDatabase")
      .mockResolvedValue(new Blob(["-- sql"]));
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    renderWithProviders(<DatabasePage />);
    await userEvent.click(screen.getByRole("button", { name: /download backup/i }));

    await waitFor(() => expect(exportDatabase).toHaveBeenCalled());
    await waitFor(() => expect(click).toHaveBeenCalled());
  });
});
