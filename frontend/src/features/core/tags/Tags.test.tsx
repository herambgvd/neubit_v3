/**
 * A tag is attached to sites, zones and devices, so deleting one detaches it
 * everywhere — hence the confirm gate. `is_active` is the field that differs
 * between the create and the edit body, and sending it on create is a 422.
 */
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import type { TagPublic } from "@/lib/types";
import { httpError, paged, stubApi, type ApiStub } from "@/test/apiStub";
import { renderWithProviders } from "@/test/render";

import TagsConfigPage from "./Tags";

const tag = (over: Partial<TagPublic> = {}): TagPublic => ({
  tag_id: "t1",
  name: "Critical",
  color: "#3B82F6",
  description: "High-priority assets",
  is_active: true,
  usage_count: 3,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  ...over,
});

const CRITICAL = tag();
const ARCHIVED = tag({ tag_id: "t2", name: "Archived", description: "Retired assets" });

let stub: ApiStub;

beforeEach(() => {
  stub = stubApi({
    "GET /tags": paged([CRITICAL, ARCHIVED]),
    "POST /tags": CRITICAL,
    "PATCH /tags/*": CRITICAL,
    "DELETE /tags/*": {},
  });
});

describe("a failed load", () => {
  it("reports the failure instead of claiming there are no tags", async () => {
    stub.set({ "GET /tags": () => httpError(500, "Tag store unreachable") });

    renderWithProviders(<TagsConfigPage />);

    expect(await screen.findByText("Tag store unreachable")).toBeInTheDocument();
    expect(screen.queryByText(/no tags yet/i)).not.toBeInTheDocument();
  });
});

describe("which row is open", () => {
  it("opens the first tag when the operator has chosen none", async () => {
    renderWithProviders(<TagsConfigPage />);

    expect(await screen.findAllByText("Critical")).not.toHaveLength(0);
    expect(screen.queryByText(/no tag selected/i)).not.toBeInTheDocument();
  });

  it("does not snap back to the first row while a new tag is being created", async () => {
    renderWithProviders(<TagsConfigPage />);
    await screen.findAllByText("Critical");

    await userEvent.click(screen.getByRole("button", { name: /new tag/i }));

    expect(await screen.findAllByText("Create tag")).not.toHaveLength(0);
    expect(screen.queryByRole("button", { name: /^delete$/i })).not.toBeInTheDocument();
  });
});

describe("deleting a tag", () => {
  it("asks for confirmation and sends nothing until it is given", async () => {
    renderWithProviders(<TagsConfigPage />);
    await screen.findAllByText("Critical");

    await userEvent.click(screen.getByRole("button", { name: /^delete$/i }));

    expect(await screen.findByText(/detached from every entity/i)).toBeInTheDocument();
    expect(stub.matching("DELETE /tags/*")).toHaveLength(0);
  });

  it("deletes the tag that was open once confirmed", async () => {
    renderWithProviders(<TagsConfigPage />);
    await screen.findAllByText("Critical");
    await userEvent.click(screen.getAllByText("Archived")[0]);

    await userEvent.click(await screen.findByRole("button", { name: /^delete$/i }));
    // The pane's Delete and the dialog's confirm share a name; the dialog's is last.
    await userEvent.click(screen.getAllByRole("button", { name: "Delete" }).at(-1)!);

    await waitFor(() => expect(stub.matching("DELETE /tags/*")).toHaveLength(1));
    expect(stub.matching("DELETE /tags/*")[0].url).toBe("/tags/t2");
  });
});

describe("the tag form", () => {
  it("refuses to create a nameless tag before the network sees it", async () => {
    renderWithProviders(<TagsConfigPage />);
    await screen.findAllByText("Critical");
    await userEvent.click(screen.getByRole("button", { name: /new tag/i }));

    await userEvent.click(await screen.findByRole("button", { name: /create tag/i }));

    expect(await screen.findByText("Name is required")).toBeInTheDocument();
    expect(stub.matching("POST /tags")).toHaveLength(0);
  });

  it("leaves is_active off the create body — the backend sets it", async () => {
    renderWithProviders(<TagsConfigPage />);
    await screen.findAllByText("Critical");
    await userEvent.click(screen.getByRole("button", { name: /new tag/i }));

    await userEvent.type(await screen.findByPlaceholderText("Enter tag name"), "After hours");
    await userEvent.click(screen.getByRole("button", { name: /create tag/i }));

    await waitFor(() => expect(stub.matching("POST /tags")).toHaveLength(1));
    const body = stub.body("POST /tags") || {};
    expect(body).not.toHaveProperty("is_active");
    expect(body).toMatchObject({ name: "After hours", description: null });
    expect(body.color).toMatch(/^#[0-9A-Fa-f]{6}$/);
  });

  it("carries is_active on the edit body, which is where it is settable", async () => {
    renderWithProviders(<TagsConfigPage />);
    await screen.findAllByText("Critical");
    await userEvent.click(screen.getByRole("button", { name: /^edit$/i }));

    await userEvent.click(await screen.findByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(stub.matching("PATCH /tags/*")).toHaveLength(1));
    expect(stub.matching("PATCH /tags/*")[0].url).toBe("/tags/t1");
    expect(stub.body("PATCH /tags/*")).toHaveProperty("is_active", true);
  });
});
