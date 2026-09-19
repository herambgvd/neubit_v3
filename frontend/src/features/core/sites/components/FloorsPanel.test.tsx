/**
 * The floors list offers four writes — add, rename, open the plan editor,
 * delete — and core gates each on its own key: `floors.create`,
 * `floors.update`, `floors.delete`. None of this is a security boundary; the
 * server refuses a caller without the key whatever this list shows. What the
 * list must not do is offer the press: a control that can only ever end in a
 * 403 is a promise the product cannot keep.
 *
 * The plan editor counts as a write. It looks like a viewer and it isn't — it
 * saves the floor's drawing and the zones on it.
 */
import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";
import { sites as sitesApi } from "@/lib/api/sites";
import type { SitePublic } from "@/lib/types";

import FloorsPanel from "./FloorsPanel";

const perms = { can: (_p: string) => true };
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ can: (p: string) => perms.can(p) }) }));
vi.mock("@/components/floor-builder/FloorPlanEditor", () => ({
  FloorPlanEditorModal: () => null,
}));

const SITE = { site_id: "s1", name: "Aeon Tower" } as unknown as SitePublic;

beforeEach(() => {
  perms.can = () => true;
  vi.spyOn(sitesApi.floors, "list").mockResolvedValue({
    items: [{ floor_id: "f1", site_id: "s1", name: "Level 4", floor_number: 4 }],
    total: 1,
  } as never);
});

describe("the floors list", () => {
  it("offers every write to a caller who holds every key", async () => {
    renderWithProviders(<FloorsPanel site={SITE} />);

    expect(await screen.findByText("Level 4")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Add floor/ })).toBeInTheDocument();
    expect(screen.getByTitle("Edit")).toBeInTheDocument();
    expect(screen.getByTitle("Delete")).toBeInTheDocument();
    expect(screen.getByTitle("Open floor plan editor")).toBeInTheDocument();
  });

  it("offers no Add floor without floors.create", async () => {
    perms.can = (p) => p !== "floors.create";
    renderWithProviders(<FloorsPanel site={SITE} />);

    expect(await screen.findByText("Level 4")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Add floor/ })).not.toBeInTheDocument();
  });

  it("offers neither rename nor the plan editor without floors.update", async () => {
    perms.can = (p) => p !== "floors.update";
    renderWithProviders(<FloorsPanel site={SITE} />);

    expect(await screen.findByText("Level 4")).toBeInTheDocument();
    expect(screen.queryByTitle("Edit")).not.toBeInTheDocument();
    // The editor writes the plan and its zones, so it goes with the rename.
    expect(screen.queryByTitle("Open floor plan editor")).not.toBeInTheDocument();
  });

  it("offers no Delete without floors.delete, and keeps the rest", async () => {
    // The keys are separate on the server, so they are separate here.
    perms.can = (p) => p !== "floors.delete";
    renderWithProviders(<FloorsPanel site={SITE} />);

    expect(await screen.findByText("Level 4")).toBeInTheDocument();
    expect(screen.queryByTitle("Delete")).not.toBeInTheDocument();
    expect(screen.getByTitle("Edit")).toBeInTheDocument();
  });

  it("still lists the floors for a caller who may change nothing", async () => {
    // Read-only is a real role. Hiding the floors along with the controls would
    // tell a reader less than the screen knows.
    perms.can = () => false;
    renderWithProviders(<FloorsPanel site={SITE} />);

    expect(await screen.findByText("Level 4")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Add floor/ })).not.toBeInTheDocument();
  });
});
