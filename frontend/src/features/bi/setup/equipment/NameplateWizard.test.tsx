/**
 * Machine details — one question at a time, and what each press SENDS.
 *
 *   • the band is offered as the readings showed it: pressing "yes" writes that
 *     range, and nothing else on the machine is touched;
 *   • a band with no observation is typed, never guessed at for the operator;
 *   • a skip writes nothing at all and moves on;
 *   • every question says which one thing a skip costs, so skipping is informed
 *     rather than discouraged;
 *   • the run ends with what was saved and what was left.
 */
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { stubApi, type ApiStub } from "@/test/apiStub";
import { renderWithProviders } from "@/test/render";

import NameplateWizard from "./NameplateWizard";
import type { Nameplate, NameplateQuestion } from "./nameplate";

vi.mock("@/lib/auth", () => ({ useAuth: () => ({ can: () => true, hasModule: () => true }) }));

const BAND: NameplateQuestion = {
  kind: "band" as const,
  facts: ["design_dt_min", "design_dt_max"],
  unit: "K",
  observed: { low: 4.8, high: 6.9, median: 5.6, hours: 512, days: 30, wide: false, spread: [4.2, 7.4] },
  blocks: ["chw_delta_t_in_band"],
};
const CAPACITY: NameplateQuestion = {
  kind: "capacity" as const,
  facts: ["tr"],
  unit: "TR",
  label: "Rated capacity",
  observed: null,
  blocks: ["chiller_kw_per_tr"],
};

const data = (questions = [BAND, CAPACITY]): Nameplate => ({
  site_id: "s1",
  days: 30,
  asks: [{ equipment_id: "e5", tag: "CH-01", name: null, equipment_class: "chiller", questions }],
  totals: { machines: 1, of_interest: 1, asked: 1, answered: 0 },
});

let stub: ApiStub;

beforeEach(() => {
  stub = stubApi({ "PUT /sites/s1/infrastructure/*": {} });
});

const render = (d: Nameplate = data(), designs = { e5: { make: "York" } }) => {
  renderWithProviders(<NameplateWizard siteId="s1" data={d} designs={designs} onClose={() => {}} />);
  return userEvent.setup();
};
const put = () => stub.body("PUT /sites/s1/infrastructure/equipment/e5/design");

describe("the band", () => {
  it("offers what the readings showed, and writes exactly that on a yes", async () => {
    const user = render();

    expect(screen.getByRole("heading", { name: /cooled the water by 4.8–6.9 °C/ })).toBeInTheDocument();
    expect(screen.getByText(/512 hours of running in the last 30 days/)).toBeInTheDocument();
    expect(screen.queryByText(/ran all over the place/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Yes, that is normal" }));

    // The one fact this screen never shows went back untouched.
    await waitFor(() => expect(put()).toEqual({ design: { make: "York", design_dt_min: 4.8, design_dt_max: 6.9 } }));
  });

  it("lets the real numbers be typed instead, and refuses a pair the wrong way round", async () => {
    const user = render();
    await user.click(screen.getByRole("button", { name: "No — I have the real numbers" }));

    await user.type(screen.getByLabelText("Smallest drop"), "7");
    await user.type(screen.getByLabelText("Biggest drop"), "5");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByText("The second number has to be the bigger one.")).toBeInTheDocument();
    expect(stub.matching("PUT /sites/s1/infrastructure/*")).toHaveLength(0);

    await user.clear(screen.getByLabelText("Biggest drop"));
    await user.type(screen.getByLabelText("Biggest drop"), "9");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(put()).toEqual({ design: { make: "York", design_dt_min: 7, design_dt_max: 9 } }));
  });

  it("says so when the machine ran all over the place, rather than letting it pass as a band", async () => {
    // The live estate: one chiller's spread ran 0.4-8.5 °C over the window.
    render(data([{ ...BAND, observed: { ...BAND.observed!, wide: true, spread: [0.4, 8.5] } }]));

    expect(screen.getByText(/ran all over the place — 0.4 to 8.5 °C/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "No — I have the real numbers" })).toBeInTheDocument();
  });

  it("asks for it plainly when there are not enough readings to show it", async () => {
    render(data([{ ...BAND, observed: null }]));
    expect(screen.getByText(/not enough hours of both water readings yet/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Yes, that is normal" })).not.toBeInTheDocument();
  });
});

describe("the capacity", () => {
  it("says where to look and writes the number typed", async () => {
    const user = render(data([CAPACITY]));

    expect(screen.getByText(/metal plate bolted to the machine/)).toBeInTheDocument();
    await user.type(screen.getByLabelText("Rated capacity"), "350");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(put()).toEqual({ design: { make: "York", tr: 350 } }));
  });

  it("refuses what the plate could not say rather than sending it", async () => {
    const user = render(data([CAPACITY]));
    await user.type(screen.getByLabelText("Rated capacity"), "-3");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(screen.getByText("That is not a number the plate would carry.")).toBeInTheDocument();
    expect(stub.matching("PUT /sites/s1/infrastructure/*")).toHaveLength(0);
  });
});

describe("skipping", () => {
  it("writes nothing, moves on, and the run says what was left", async () => {
    const user = render();
    expect(screen.getByText(/whether it is cooling the water as much as it should/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Not sure · skip" }));
    expect(await screen.findByText(/how much power it draws per ton of cooling/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Not on the plate · skip" }));

    expect(await screen.findByText("Nothing saved.")).toBeInTheDocument();
    expect(screen.getByText(/2 skipped/)).toBeInTheDocument();
    expect(stub.matching("PUT /sites/s1/infrastructure/*")).toHaveLength(0);
  });

  it("counts what was saved when the queue runs out", async () => {
    const user = render(data([CAPACITY]));
    await user.type(screen.getByLabelText("Rated capacity"), "350");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("1 machine detail saved.")).toBeInTheDocument();
  });

  it("shows the server's own sentence when a save is refused", async () => {
    stub.set({
      "PUT /sites/s1/infrastructure/*": () => {
        throw Object.assign(new Error("x"), {
          isAxiosError: true,
          response: { data: { error: { code: "ERR", message: "design_dt_min must be below design_dt_max" } }, status: 422 },
        });
      },
    });
    const user = render();
    await user.click(screen.getByRole("button", { name: "Yes, that is normal" }));

    expect(await screen.findByText(/design_dt_min must be below design_dt_max/)).toBeInTheDocument();
  });
});
