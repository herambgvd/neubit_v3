/**
 * The browser tab: the title and the icon, both from branding.
 *
 * The favicon is the half that is easy to get wrong. Next emits its own
 * `<link rel="icon">` from app/icon.svg, browsers take the LAST matching one, and
 * a navigation re-inserts Next's — so a tenant's icon has to be re-asserted and
 * has to end up after it. And when a tenant has none, the element must be REMOVED
 * rather than pointed at nothing, or the app's own icon never comes back.
 */
import { waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { stubApi } from "@/test/apiStub";
import { renderWithProviders } from "@/test/render";

import TitleSync from "./TitleSync";

vi.mock("next/navigation", () => ({ usePathname: () => "/sites" }));

const brandLink = () => document.getElementById("brand-favicon") as HTMLLinkElement | null;

beforeEach(() => {
  document.head.innerHTML = "";
  document.title = "";
});
afterEach(() => {
  document.head.innerHTML = "";
});

describe("TitleSync", () => {
  it("puts the tenant's name in the tab title", async () => {
    stubApi({ "GET /branding": { app_name: "Acme", logo_url: null, favicon_url: null } });
    renderWithProviders(<TitleSync />);

    await waitFor(() => expect(document.title).toBe("Acme"));
  });

  it("adds the tenant's favicon as an icon link", async () => {
    stubApi({ "GET /branding": { app_name: "Acme", logo_url: null, favicon_url: "/files/fav.png" } });
    renderWithProviders(<TitleSync />);

    await waitFor(() => expect(brandLink()).not.toBeNull());
    expect(brandLink()!.rel).toBe("icon");
    expect(brandLink()!.getAttribute("href")).toBe("/files/fav.png");
  });

  it("puts it AFTER the app's own icon, which is what makes it win", async () => {
    // What Next emits from app/icon.svg.
    const own = document.createElement("link");
    own.rel = "icon";
    own.href = "/icon.svg";
    document.head.appendChild(own);

    stubApi({ "GET /branding": { app_name: "Acme", logo_url: null, favicon_url: "/files/fav.png" } });
    renderWithProviders(<TitleSync />);

    await waitFor(() => expect(brandLink()).not.toBeNull());
    const icons = [...document.head.querySelectorAll('link[rel="icon"]')];
    expect(icons.at(-1)).toBe(brandLink());
  });

  it("REMOVES the link when the tenant has no favicon, so the app's own returns", async () => {
    const stale = document.createElement("link");
    stale.id = "brand-favicon";
    stale.rel = "icon";
    stale.href = "/files/old.png";
    document.head.appendChild(stale);

    stubApi({ "GET /branding": { app_name: "Acme", logo_url: null, favicon_url: null } });
    renderWithProviders(<TitleSync />);

    await waitFor(() => expect(document.title).toBe("Acme"));
    expect(brandLink()).toBeNull();
  });

  it("keeps one link rather than a new one per render", async () => {
    stubApi({ "GET /branding": { app_name: "Acme", logo_url: null, favicon_url: "/files/fav.png" } });
    const { rerender } = renderWithProviders(<TitleSync />);

    await waitFor(() => expect(brandLink()).not.toBeNull());
    rerender(<TitleSync />);

    expect(document.head.querySelectorAll("#brand-favicon")).toHaveLength(1);
  });
});
