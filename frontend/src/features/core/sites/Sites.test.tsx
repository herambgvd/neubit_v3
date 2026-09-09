/**
 * Deleting a site takes its floors, zones and every device placement with it, so
 * the confirm gate is load-bearing. The form body matters for the same reason the
 * user one does: address and coordinates are nested objects the backend rejects
 * when they arrive as flat strings.
 */
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SitePublic } from "@/lib/types";
import { httpError, paged, stubApi, type ApiStub, type Recorded } from "@/test/apiStub";
import { renderWithProviders } from "@/test/render";

import SitesConfigPage from "./Sites";


/**
 * SiteDetail gates its Building tab on the BI entitlement. These tests are about
 * the list and the form, so the tenant here has everything; the gate itself is
 * covered in SiteDetail.test.tsx.
 */
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { id: "me" }, can: () => true, hasModule: () => true }),
}));

const site = (over: Partial<SitePublic> = {}): SitePublic =>
  ({
    site_id: "s1",
    name: "Pune HQ",
    location_code: "PNQ-01",
    description: null,
    site_type: "building",
    parent_id: null,
    threat_level: "normal",
    address: null,
    coordinates: null,
    contact_person: null,
    contact_phone: null,
    email_address: null,
    image_url: null,
    gross_floor_area_sqm: null,
    energy_tariff_per_kwh: null,
    tariff_currency: null,
    occupancy: null,
    building_facts_updated_at: null,
    building_facts_updated_by: null,
    is_active: true,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    floor_count: 0,
    ...over,
  }) as SitePublic;

const HQ = site();
const DEPOT = site({ site_id: "s2", name: "Nashik Depot", location_code: "NSK-01" });

let stub: ApiStub;

beforeEach(() => {
  stub = stubApi({
    "GET /sites": paged([HQ, DEPOT]),
    "GET /floors": paged([]),
    "GET /zones": paged([]),
    "GET /tags": paged([]),
    "POST /sites": HQ,
    "PATCH /sites/*": HQ,
    "DELETE /sites/*": {},
    "PUT /sites/*": HQ,
    "POST /sites/*": HQ,
  });
});

describe("a failed load", () => {
  it("reports the failure instead of claiming there are no sites", async () => {
    stub.set({ "GET /sites": () => httpError(502, "Site service unreachable") });

    renderWithProviders(<SitesConfigPage />);

    expect(await screen.findByText("Site service unreachable")).toBeInTheDocument();
    expect(screen.queryByText(/no sites yet/i)).not.toBeInTheDocument();
  });
});

describe("which row is open", () => {
  it("opens the first site when the operator has chosen none", async () => {
    renderWithProviders(<SitesConfigPage />);

    expect(await screen.findAllByText("Pune HQ")).not.toHaveLength(0);
    expect(screen.queryByText(/no site selected/i)).not.toBeInTheDocument();
  });

  it("does not re-open a site the operator has explicitly closed", async () => {
    renderWithProviders(<SitesConfigPage />);
    await screen.findAllByText("Pune HQ");

    await userEvent.click(screen.getByRole("button", { name: "Close" }));

    // The fallback must be "nothing chosen yet", not "always show something".
    expect(await screen.findByText(/no site selected/i)).toBeInTheDocument();
  });
});

describe("deactivating a site", () => {
  it("asks first, and says what actually happens", async () => {
    // `DELETE /sites/{id}` sets is_active=false and cascades that to the floors
    // and zones. The prompt used to say "and all of its floors and zones … this
    // cannot be undone", which was wrong twice: nothing is destroyed, and
    // `restore` puts it all back.
    renderWithProviders(<SitesConfigPage />);
    await screen.findAllByText("Pune HQ");

    await userEvent.click(screen.getByRole("button", { name: /deactivate site/i }));

    expect(await screen.findByText(/nothing is deleted/i)).toBeInTheDocument();
    expect(stub.matching("DELETE /sites/*")).toHaveLength(0);
  });

  it("deactivates the site that was open, not the first one in the list", async () => {
    renderWithProviders(<SitesConfigPage />);
    await screen.findAllByText("Pune HQ");
    await userEvent.click(screen.getAllByText("Nashik Depot")[0]);

    await userEvent.click(await screen.findByRole("button", { name: /deactivate site/i }));
    await userEvent.click(await screen.findByRole("button", { name: "Deactivate" }));

    await waitFor(() => expect(stub.matching("DELETE /sites/*")).toHaveLength(1));
    expect(stub.matching("DELETE /sites/*")[0].url).toBe("/sites/s2");
  });
});

describe("the sites that were deactivated", () => {
  it("asks the API for them — they are hidden from the default list, not gone", async () => {
    // Without this the console had no way back to a deactivated site: the list
    // defaults to is_active=true, so the row vanished, and nothing called the
    // restore endpoint that exists to bring it back.
    renderWithProviders(<SitesConfigPage />);
    await screen.findAllByText("Pune HQ");

    await userEvent.click(screen.getByRole("button", { name: /show deactivated sites/i }));

    await waitFor(() =>
      // `sites.list` builds the query into the URL, so the values are in `search`.
      expect(stub.matching("GET /sites").some((c) => c.search.get("is_active") === "false")).toBe(
        true,
      ),
    );
  });

  it("restores one instead of offering to delete it again", async () => {
    stub.set({
      "GET /sites": (req: Recorded) =>
        req.search.get("is_active") === "false"
          ? { items: [{ ...HQ, is_active: false }], total: 1 }
          : { items: [HQ, DEPOT], total: 2 },
    });
    renderWithProviders(<SitesConfigPage />);
    await screen.findAllByText("Pune HQ");

    await userEvent.click(screen.getByRole("button", { name: /show deactivated sites/i }));
    await userEvent.click(await screen.findByRole("button", { name: /restore/i }));

    await waitFor(() => expect(stub.matching("POST /sites/s1/restore")).toHaveLength(1));
  });
});

describe("starting a new site", () => {
  it("opens the form from the panel plus — the only way in now the footer button is gone", async () => {
    renderWithProviders(<SitesConfigPage />);
    await screen.findAllByText("Pune HQ");

    await userEvent.click(screen.getByRole("button", { name: /new site/i }));

    expect(await screen.findByRole("button", { name: /create site/i })).toBeInTheDocument();
  });
});

describe("the site form", () => {
  it("refuses to create a nameless site before the network sees it", async () => {
    renderWithProviders(<SitesConfigPage />);
    await screen.findAllByText("Pune HQ");
    await userEvent.click(screen.getByRole("button", { name: /new site/i }));

    await userEvent.click(await screen.findByRole("button", { name: /create site/i }));

    expect(await screen.findByText(/site name is required/i)).toBeInTheDocument();
    expect(stub.matching("POST /sites")).toHaveLength(0);
  });

  it("sends the address as the nested object the API stores, not flat fields", async () => {
    renderWithProviders(<SitesConfigPage />);
    await screen.findAllByText("Pune HQ");
    await userEvent.click(screen.getByRole("button", { name: /new site/i }));

    await userEvent.type(await screen.findByPlaceholderText("Enter site name"), "Mumbai Annexe");
    await userEvent.type(screen.getByPlaceholderText("City"), "Mumbai");
    await userEvent.click(screen.getByRole("button", { name: /create site/i }));

    await waitFor(() => expect(stub.matching("POST /sites")).toHaveLength(1));
    const body = stub.body("POST /sites") || {};
    expect(body.name).toBe("Mumbai Annexe");
    expect(body.address).toMatchObject({ city: "Mumbai" });
    expect(body).not.toHaveProperty("city");
  });

  it("sends null coordinates rather than an empty pair when none were picked", async () => {
    renderWithProviders(<SitesConfigPage />);
    await screen.findAllByText("Pune HQ");
    await userEvent.click(screen.getByRole("button", { name: /new site/i }));

    await userEvent.type(await screen.findByPlaceholderText("Enter site name"), "Mumbai Annexe");
    await userEvent.click(screen.getByRole("button", { name: /create site/i }));

    await waitFor(() => expect(stub.matching("POST /sites")).toHaveLength(1));
    const body = stub.body("POST /sites") || {};
    // A half-filled { latitude: "", longitude: "" } would land the site at 0,0.
    expect(body.coordinates).toBeNull();
    expect(body.address).toMatchObject({ street: null, city: null, zip_code: null });
  });

  it("keeps letters out of the zip code rather than posting one the API rejects", async () => {
    renderWithProviders(<SitesConfigPage />);
    await screen.findAllByText("Pune HQ");
    await userEvent.click(screen.getByRole("button", { name: /new site/i }));

    await userEvent.type(await screen.findByPlaceholderText("Enter site name"), "Mumbai Annexe");
    await userEvent.type(screen.getByPlaceholderText("Zip code"), "AB");

    // The field sanitises as you type, so letters never even land in the box.
    expect(screen.getByPlaceholderText("Zip code")).toHaveValue("");
    await userEvent.click(screen.getByRole("button", { name: /create site/i }));
    await waitFor(() => expect(stub.matching("POST /sites")).toHaveLength(1));
    expect((stub.body("POST /sites") || {}).address).toMatchObject({ zip_code: null });
  });
});
