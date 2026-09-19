/**
 * GATE 6's screen. What it must never do: compose the evidence itself, offer a
 * second ticket for a finding that already has one, or report a raise that only
 * returned the incident already open.
 */
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";

import Work from "./Work";
import { bi } from "./api";
import { workflow } from "@/features/workflow/api";

const perms = { can: (_p: string) => true, hasModule: (_m: string) => true };
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ can: (p: string) => perms.can(p), hasModule: (m: string) => perms.hasModule(m) }),
}));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams({ site: "s1" }) }));
// The strip has its own suite; here it is noise.
vi.mock("./components/GateStrip", () => ({ default: () => null }));

const WORK = {
  source_key: "bi:equipment:e1:slot:chws",
  name: "CH-1 · CHW supply has gone quiet",
  description: "Bound to 1FYC1_OWT, which produced no reading in the last hour.",
  site_id: "s1",
  trigger_data: { source: "bi", raised_by: "operator", type: "bi.finding.data_fault", payload: {} },
};

const FINDING = {
  source_key: WORK.source_key,
  kind: "data_fault",
  status: "silent",
  equipment_id: "e1",
  equipment_tag: "CH-1",
  title: "CHW supply has gone quiet",
  summary: "The binding is right and the sensor stopped.",
  evidence: {},
  work: WORK,
};

/** A metric that computed. It is NOT work, and must not appear. */
const HEALTHY = {
  ...FINDING,
  source_key: "bi:equipment:e1:metric:chw_delta_t_in_band",
  kind: "equipment_metric",
  status: "ok",
  title: "CHW ΔT in band",
  work: { ...WORK, source_key: "bi:equipment:e1:metric:chw_delta_t_in_band", name: "ΔT" },
};

function wire(over: { findings?: unknown[]; open?: Record<string, unknown> } = {}) {
  vi.spyOn(bi, "findings").mockResolvedValue({
    site_id: "s1",
    site_name: "Aeon Tower",
    findings: over.findings ?? [FINDING, HEALTHY],
  });
  vi.spyOn(bi, "alerts").mockResolvedValue({ available: true, items: [] });
  vi.spyOn(workflow.instances, "openBySource").mockResolvedValue({
    with_work: over.open ?? {},
    without_work: [],
  } as never);
  vi.spyOn(workflow.sops, "list").mockResolvedValue({
    items: [{ sop_id: "sop-1", name: "General alarm", trigger_event_types: [] }],
    total: 1,
  } as never);
}

beforeEach(() => {
  perms.can = () => true;
  perms.hasModule = () => true;
});

describe("the worklist", () => {
  it("lists a finding to act on and never a metric that computed", async () => {
    wire();
    renderWithProviders(<Work />);

    expect(await screen.findByText(/CHW supply has gone quiet/)).toBeInTheDocument();
    // `ok` is not a pass mark, so it is not a fault either.
    expect(screen.queryByText(/CHW ΔT in band/)).not.toBeInTheDocument();
  });

  it("names the window it read, rather than implying all time", async () => {
    wire();
    renderWithProviders(<Work />);
    expect(await screen.findByText("last 24 h")).toBeInTheDocument();
  });

  it("shows the work already open instead of offering a second ticket", async () => {
    wire({
      findings: [FINDING],
      open: {
        [WORK.source_key]: {
          instance_id: "i1",
          name: "INC-1",
          sop_name: "General alarm",
          status: "open",
          priority: null,
          current_state_name: "Triage",
          assigned_to: null,
          created_at: "t",
        },
      },
    });
    renderWithProviders(<Work />);

    expect(await screen.findByText("already being worked on")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Triage/ })).toHaveAttribute(
      "href",
      "/workflow/incidents?instance=i1",
    );
    expect(screen.queryByRole("button", { name: "Raise work" })).not.toBeInTheDocument();
  });

  it("is offered to nobody without workflow.instance.create", async () => {
    perms.can = (p) => p !== "workflow.instance.create";
    wire({ findings: [FINDING] });
    renderWithProviders(<Work />);

    expect(await screen.findByText(/CHW supply has gone quiet/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Raise work" })).not.toBeInTheDocument();
    expect(screen.getByText(/needs workflow.instance.create/)).toBeInTheDocument();
  });

  it("asks the store for nothing without bi.read", async () => {
    perms.can = (p) => p !== "bi.read";
    wire({ findings: [FINDING] });
    renderWithProviders(<Work />);

    expect(await screen.findByText(/Reading findings needs bi.read/)).toBeInTheDocument();
    expect(bi.findings).not.toHaveBeenCalled();
  });
});

describe("raising work", () => {
  /** The kit's Select is a listbox, not a native <select>. */
  async function pickProcedure() {
    await userEvent.click(screen.getByRole("button", { name: "Procedure" }));
    await userEvent.click(await screen.findByRole("option", { name: "General alarm" }));
  }

  async function openModal() {
    wire({ findings: [FINDING] });
    renderWithProviders(<Work />);
    await userEvent.click(await screen.findByRole("button", { name: "Raise work" }));
  }

  it("posts the store's own block, with only the procedure added", async () => {
    const raise = vi
      .spyOn(workflow.instances, "raise")
      .mockResolvedValue({ created: true, instance: { instance_id: "i9", name: "INC-9" } } as never);
    await openModal();

    const dialog = screen.getByRole("dialog");
    // The evidence is readable BEFORE the press, and it is the store's wording.
    expect(within(dialog).getByText(WORK.description)).toBeInTheDocument();

    await pickProcedure();
    await userEvent.click(within(dialog).getByRole("button", { name: "Raise work" }));

    expect(raise).toHaveBeenCalledWith({ ...WORK, sop_id: "sop-1" });
  });

  it("will not post until a procedure is chosen", async () => {
    const raise = vi.spyOn(workflow.instances, "raise").mockResolvedValue({} as never);
    await openModal();
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Choose a procedure" })).toBeDisabled();
    expect(raise).not.toHaveBeenCalled();
  });

  it("says CREATED when the store created one", async () => {
    vi.spyOn(workflow.instances, "raise").mockResolvedValue({
      created: true,
      instance: { instance_id: "i9", name: "INC-9" },
    } as never);
    await openModal();
    const dialog = screen.getByRole("dialog");
    await pickProcedure();
    await userEvent.click(within(dialog).getByRole("button", { name: "Raise work" }));

    expect(await screen.findByText("Work raised")).toBeInTheDocument();
  });

  it("says ALREADY OPEN when the store returned the incident that existed", async () => {
    // 200, not 201. An operator told "raised" would think they had just made a
    // second ticket — the one thing the source key exists to prevent.
    vi.spyOn(workflow.instances, "raise").mockResolvedValue({
      created: false,
      instance: { instance_id: "i1", name: "INC-1" },
    } as never);
    await openModal();
    const dialog = screen.getByRole("dialog");
    await pickProcedure();
    await userEvent.click(within(dialog).getByRole("button", { name: "Raise work" }));

    expect(await screen.findByText("Already open")).toBeInTheDocument();
    expect(screen.getByText(/Nothing was raised a second time/)).toBeInTheDocument();
  });
});

describe("a deployment with no procedures", () => {
  /** Raising REQUIRES one, so an empty select is a dead end, not a slow load. */
  async function openWithNoSops() {
    wire({ findings: [FINDING] });
    vi.spyOn(workflow.sops, "list").mockResolvedValue({ items: [], total: 0 } as never);
    renderWithProviders(<Work />);
    await userEvent.click(await screen.findByRole("button", { name: "Raise work" }));
  }

  it("offers the BUILDING set, never the recorder's", async () => {
    const install = vi
      .spyOn(workflow.sops, "installStarters")
      .mockResolvedValue({ items: [], created: 3, skipped: [] } as never);
    await openWithNoSops();

    expect(await screen.findByText("No procedures yet")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Install the building playbooks/ }));
    // A tenant that never bought the recorder has no use for camera tamper.
    expect(install).toHaveBeenCalledWith("bi");
  });

  it("says who can fix it rather than offering a press that 403s", async () => {
    perms.can = (p) => p !== "workflow.sop.create";
    const install = vi.spyOn(workflow.sops, "installStarters").mockResolvedValue({} as never);
    await openWithNoSops();

    expect(await screen.findByText(/Needs workflow.sop.create/)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Install the building playbooks/ }),
    ).not.toBeInTheDocument();
    expect(install).not.toHaveBeenCalled();
  });

  it("says nothing of the sort while the list is still loading", async () => {
    wire({ findings: [FINDING] });
    let settle: (v: unknown) => void = () => {};
    vi.spyOn(workflow.sops, "list").mockReturnValue(new Promise((r) => { settle = r; }) as never);
    renderWithProviders(<Work />);
    await userEvent.click(await screen.findByRole("button", { name: "Raise work" }));

    expect(screen.queryByText("No procedures yet")).not.toBeInTheDocument();
    settle({ items: [], total: 0 });
    expect(await screen.findByText("No procedures yet")).toBeInTheDocument();
  });
});
