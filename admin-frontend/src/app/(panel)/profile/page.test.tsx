import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { adminApi } from "@/lib/api";
import type { Role, User } from "@/lib/types";
import { renderWithProviders } from "@/test/render";

import ProfilePage from "./page";

const role: Role = {
  id: "r1",
  name: "Administrator",
  description: null,
  permissions: ["*"],
  is_system: true,
  created_at: "2026-01-01T00:00:00Z",
};

describe("profile", () => {
  it("shows the signed-in super-admin", async () => {
    vi.spyOn(adminApi, "me").mockResolvedValue({
      id: "u1",
      email: "root@neubit",
      full_name: "Root Admin",
      role,
      is_superadmin: true,
      is_active: true,
    } as User);

    renderWithProviders(<ProfilePage />);

    expect(await screen.findByText("Root Admin")).toBeInTheDocument();
    expect(screen.getByText("root@neubit")).toBeInTheDocument();
    expect(screen.getByText("Administrator")).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
  });

  it("falls back to the email initial when there is no name", async () => {
    vi.spyOn(adminApi, "me").mockResolvedValue({
      id: "u1",
      email: "root@neubit",
      full_name: null,
      role,
      is_superadmin: true,
      is_active: true,
    } as User);

    renderWithProviders(<ProfilePage />);

    expect(await screen.findByText("R")).toBeInTheDocument();
  });

  it("reports a failed load", async () => {
    vi.spyOn(adminApi, "me").mockRejectedValue(new Error("session gone"));

    renderWithProviders(<ProfilePage />);

    expect(await screen.findByText(/session gone/i)).toBeInTheDocument();
  });
});
