/**
 * Identity is three things a tenant replaces: the name, the logo, and the
 * favicon. Nothing else.
 *
 * The brand-colour pickers are gone because they coloured nothing but the swatch
 * beside themselves, and "show app name in header" went with them. This file
 * asserts their ABSENCE as well as the presence of what replaced them — a
 * retired control that quietly comes back is exactly how the last one survived.
 */
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { stubApi, type ApiStub } from "@/test/apiStub";
import { renderWithProviders } from "@/test/render";

import BrandingPage from "./Branding";

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { id: "me" }, can: () => true, hasModule: () => true }),
}));

let stub: ApiStub;

beforeEach(() => {
  stub = stubApi({
    "GET /branding": {
      id: "b1",
      app_name: "Acme",
      logo_url: "/files/logo.png",
      favicon_url: "/files/favicon.png",
    },
    "PUT /branding": { id: "b1", app_name: "Acme", logo_url: null, favicon_url: null },
    "POST /branding/logo": { id: "b1", app_name: "Acme", logo_url: "/files/new.png", favicon_url: null },
    "POST /branding/favicon": { id: "b1", app_name: "Acme", logo_url: null, favicon_url: "/files/fav.png" },
  });
});

describe("the branding editor", () => {
  it("offers the app name, a logo upload and a favicon upload", async () => {
    renderWithProviders(<BrandingPage />);

    expect(await screen.findByDisplayValue("Acme")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Upload logo" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Upload favicon" })).toBeInTheDocument();
  });

  it("offers no brand colours and no header-name switch", async () => {
    renderWithProviders(<BrandingPage />);
    await screen.findByDisplayValue("Acme");

    expect(screen.queryByText(/primary color/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/accent color/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/show app name in header/i)).not.toBeInTheDocument();
    // The one that would survive a text search: the toggle it used to render.
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  });

  it("sends the favicon to its own endpoint, not the logo's", async () => {
    renderWithProviders(<BrandingPage />);
    await screen.findByDisplayValue("Acme");

    const input = document.querySelectorAll<HTMLInputElement>('input[type="file"]')[1];
    await userEvent.upload(input, new File(["x"], "fav.png", { type: "image/png" }));

    expect(stub.matching("POST /branding/favicon")).toHaveLength(1);
    expect(stub.matching("POST /branding/logo")).toHaveLength(0);
  });

  it("previews the tab and the console mark, not a colour it does not apply", async () => {
    renderWithProviders(<BrandingPage />);

    expect(await screen.findByText("Browser tab")).toBeInTheDocument();
    expect(screen.getByText("Console mark")).toBeInTheDocument();
    const images = screen.getAllByRole("img");
    expect(images.some((i) => i.getAttribute("src") === "/files/favicon.png")).toBe(true);
  });

  it("falls back to the app name when there is no logo, and says so", async () => {
    stub.set({
      "GET /branding": { id: "b1", app_name: "Acme", logo_url: null, favicon_url: null },
    });
    renderWithProviders(<BrandingPage />);

    expect(await screen.findByText(/No logo uploaded/i)).toBeInTheDocument();
  });
});
