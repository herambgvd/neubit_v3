/**
 * An access group is a door permission set: deleting one silently strips access
 * from every cardholder in it, and a schedule delete quietly promotes its groups
 * to always-allowed. Both are behind a confirm for that reason.
 *
 * The door chips are the second thing pinned here — they indexed on `door_id`,
 * a field DoorPublic does not carry, so every chip showed a truncated uuid.
 */
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import type { AccessDoorPublic } from "@/lib/types";
import { paged, stubApi, type ApiStub } from "@/test/apiStub";
import { renderWithProviders } from "@/test/render";
import type { AccessGroupPublic, SchedulePublic } from "../types";

import AccessGroupsTab from "./AccessGroupsTab";

const DOOR: AccessDoorPublic = {
  id: "door-1",
  instance_id: "inst1",
  name: "Server Room",
  remote_ref: "CTRL-7",
  site_id: null,
  floor_id: null,
  zone_id: null,
  is_active: true,
  metadata: {},
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const SCHEDULE = {
  schedule_id: "sch-1",
  name: "Office hours",
  description: null,
  timezone: "Asia/Kolkata",
  windows: [{ days: [1, 2, 3], start_time: "09:00", end_time: "18:00" }],
  holidays: [],
} as unknown as SchedulePublic;

const GROUP = {
  group_id: "g-1",
  name: "Night crew",
  description: "After-hours access",
  door_ids: ["door-1"],
  schedule_id: "sch-1",
  has_api_key: false,
  access_group_type: "Door",
} as unknown as AccessGroupPublic;

let stub: ApiStub;

beforeEach(() => {
  stub = stubApi({
    "GET /access/access-groups": paged([GROUP]),
    "GET /access/schedules": paged([SCHEDULE]),
    "GET /access/doors": paged([DOOR]),
    "DELETE /access/access-groups/*": {},
    "DELETE /access/schedules/*": {},
    "POST /access/access-groups": GROUP,
    "PATCH /access/access-groups/*": GROUP,
    "POST /access/schedules": SCHEDULE,
    "PATCH /access/schedules/*": SCHEDULE,
    "GET /access/access-groups/*": GROUP,
    "GET /access/schedules/*": SCHEDULE,
  });
});

describe("the groups table", () => {
  it("names each door the group covers rather than showing its raw id", async () => {
    renderWithProviders(<AccessGroupsTab instanceId="inst1" />);

    expect(await screen.findByText("Server Room")).toBeInTheDocument();
  });

  it("names the schedule a group is bound to, and says so when it has none", async () => {
    stub.set({
      "GET /access/access-groups": paged([GROUP, { ...GROUP, group_id: "g-2", name: "Day crew", schedule_id: null }]),
    });

    renderWithProviders(<AccessGroupsTab instanceId="inst1" />);

    expect(await screen.findAllByText("Office hours")).not.toHaveLength(0);
    expect(screen.getByText("Always allowed")).toBeInTheDocument();
  });

  // The key is a credential; the API returns only whether one is set.
  it("reports only whether an API key exists, never a key value", async () => {
    renderWithProviders(<AccessGroupsTab instanceId="inst1" />);
    await screen.findByText("Night crew");

    expect(screen.queryByText(/secret|api-key-/i)).not.toBeInTheDocument();
  });
});

describe("deleting an access group", () => {
  it("asks for confirmation and sends nothing until it is given", async () => {
    renderWithProviders(<AccessGroupsTab instanceId="inst1" />);
    await screen.findByText("Night crew");

    await userEvent.click(screen.getAllByRole("button", { name: "Delete" })[0]);

    expect(await screen.findByText(/will lose the associated permissions/i)).toBeInTheDocument();
    expect(stub.matching("DELETE /access/access-groups/*")).toHaveLength(0);
  });

  it("deletes through the group's own id once confirmed", async () => {
    renderWithProviders(<AccessGroupsTab instanceId="inst1" />);
    await screen.findByText("Night crew");
    await userEvent.click(screen.getAllByRole("button", { name: "Delete" })[0]);

    await userEvent.click(screen.getAllByRole("button", { name: "Delete" }).at(-1)!);

    await waitFor(() => expect(stub.matching("DELETE /access/access-groups/*")).toHaveLength(1));
    expect(stub.matching("DELETE /access/access-groups/*")[0].url).toBe("/access/access-groups/g-1");
  });
});

describe("deleting a schedule", () => {
  it("warns that its groups fall back to always-allowed before anything is sent", async () => {
    renderWithProviders(<AccessGroupsTab instanceId="inst1" />);
    await screen.findAllByText("Office hours");

    await userEvent.click(screen.getAllByRole("button", { name: "Delete" })[1]);

    expect(await screen.findByText(/fall back to always-allowed/i)).toBeInTheDocument();
    expect(stub.matching("DELETE /access/schedules/*")).toHaveLength(0);
  });
});

describe("the access-group form", () => {
  it("refuses to create a nameless group before the network sees it", async () => {
    renderWithProviders(<AccessGroupsTab instanceId="inst1" />);
    await screen.findByText("Night crew");
    await userEvent.click(screen.getByRole("button", { name: /new group/i }));

    await userEvent.click(await screen.findByRole("button", { name: "Create group" }));

    expect(await screen.findByText("Required")).toBeInTheDocument();
    expect(stub.matching("POST /access/access-groups")).toHaveLength(0);
  });

  it("sends the local door ids and a null schedule for always-allowed", async () => {
    renderWithProviders(<AccessGroupsTab instanceId="inst1" />);
    await screen.findByText("Night crew");
    await userEvent.click(screen.getByRole("button", { name: /new group/i }));

    await userEvent.type(await screen.findByPlaceholderText(/e\.g\./i), "Contractors");
    await userEvent.click(screen.getByRole("checkbox", { name: /server room/i }));
    await userEvent.click(screen.getByRole("button", { name: "Create group" }));

    await waitFor(() => expect(stub.matching("POST /access/access-groups")).toHaveLength(1));
    expect(stub.body("POST /access/access-groups")).toEqual({
      name: "Contractors",
      description: null,
      door_ids: ["door-1"],
      schedule_id: null,
    });
  });

  it("scopes the create to the instance through the query, not the body", async () => {
    renderWithProviders(<AccessGroupsTab instanceId="inst1" />);
    await screen.findByText("Night crew");
    await userEvent.click(screen.getByRole("button", { name: /new group/i }));

    await userEvent.type(await screen.findByPlaceholderText(/e\.g\./i), "Contractors");
    await userEvent.click(screen.getByRole("button", { name: "Create group" }));

    await waitFor(() => expect(stub.matching("POST /access/access-groups")).toHaveLength(1));
    expect(stub.body("POST /access/access-groups")).not.toHaveProperty("instance_id");
  });
});

describe("the schedule form", () => {
  it("refuses a window whose end is not after its start", async () => {
    renderWithProviders(<AccessGroupsTab instanceId="inst1" />);
    await screen.findAllByText("Office hours");
    await userEvent.click(screen.getByRole("button", { name: /new schedule/i }));

    await userEvent.type(await screen.findByPlaceholderText("e.g. Office hours"), "Overnight");
    const times = screen.getAllByDisplayValue("18:00");
    await userEvent.clear(times[0]);
    await userEvent.type(times[0], "08:00");
    await userEvent.click(screen.getByRole("button", { name: "Create schedule" }));

    expect(await screen.findByText(/end must be after start/i)).toBeInTheDocument();
    expect(stub.matching("POST /access/schedules")).toHaveLength(0);
  });

  it("sends the windows and holidays as the lists the schedule stores", async () => {
    renderWithProviders(<AccessGroupsTab instanceId="inst1" />);
    await screen.findAllByText("Office hours");
    await userEvent.click(screen.getByRole("button", { name: /new schedule/i }));

    await userEvent.type(await screen.findByPlaceholderText("e.g. Office hours"), "Weekdays");
    await userEvent.click(screen.getByRole("button", { name: "Create schedule" }));

    await waitFor(() => expect(stub.matching("POST /access/schedules")).toHaveLength(1));
    const body = stub.body("POST /access/schedules") || {};
    expect(body).toMatchObject({ name: "Weekdays", description: null, holidays: [] });
    expect(body.windows).toEqual([{ days: [1, 2, 3, 4, 5], start_time: "09:00", end_time: "18:00" }]);
  });
});
