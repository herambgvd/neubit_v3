/**
 * The charts are hand-drawn SVG, so their geometry is the thing that can be
 * wrong while everything still renders. These assert the numbers.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { AreaTrend, BarList, ChartCard, DonutChart, Sparkline } from "./charts";

const num = (el: Element | null, attr: string) => Number(el?.getAttribute(attr));

describe("DonutChart", () => {
  const data = [
    { label: "Licensed", value: 30, color: "var(--success)" },
    { label: "Grace", value: 10, color: "var(--warning)" },
    { label: "Expired", value: 10, color: "var(--danger)" },
  ];

  it("sizes each arc in proportion and lays them end to end", () => {
    const { container } = render(<DonutChart data={data} />);
    // First circle is the track; the rest are the segments.
    const [, ...segments] = [...container.querySelectorAll("circle")];
    expect(segments).toHaveLength(3);

    const circumference = 2 * Math.PI * num(segments[0]!, "r");
    const lengths = segments.map((s) => Number(s.getAttribute("strokeDasharray")?.split(" ")[0] ?? s.getAttribute("stroke-dasharray")!.split(" ")[0]));

    // 30/50, 10/50, 10/50 of the circle.
    expect(lengths[0]!).toBeCloseTo(circumference * 0.6, 3);
    expect(lengths[1]!).toBeCloseTo(circumference * 0.2, 3);
    expect(lengths[2]!).toBeCloseTo(circumference * 0.2, 3);

    // Each segment starts where the previous one ended — the accumulation that
    // used to be a mutated `let` while mapping.
    const offsets = segments.map((s) => -Number(s.getAttribute("stroke-dashoffset")));
    expect(offsets[0]!).toBeCloseTo(0, 6);
    expect(offsets[1]!).toBeCloseTo(lengths[0]!, 6);
    expect(offsets[2]!).toBeCloseTo(lengths[0]! + lengths[1]!, 6);
    // …and the last one ends exactly on the full circle.
    expect(offsets[2]! + lengths[2]!).toBeCloseTo(circumference, 6);
  });

  it("shows the total in the centre, and the hovered slice instead on hover", async () => {
    const { container } = render(<DonutChart data={data} centerLabel="Tenants" />);
    // The legend repeats each value, so read the centre figure specifically.
    const centre = () => container.querySelector(".text-2xl")!.textContent;

    expect(centre()).toBe("50");
    expect(screen.getByText("Tenants")).toBeInTheDocument();

    await userEvent.hover(screen.getByText("Grace"));

    expect(centre()).toBe("10");
    expect(screen.queryByText("Tenants")).not.toBeInTheDocument();
  });

  it("formats values through formatValue", () => {
    render(<DonutChart data={data} formatValue={(n) => `${n} tenants`} />);

    expect(screen.getByText("50 tenants")).toBeInTheDocument();
  });

  it("renders the empty state rather than dividing by zero", () => {
    const { container } = render(
      <DonutChart data={[{ label: "None", value: 0, color: "var(--muted)" }]} />
    );

    expect(screen.getByText(/no data/i)).toBeInTheDocument();
    expect(container.querySelectorAll("circle")).toHaveLength(0);
  });

  it("treats a missing value as zero", () => {
    const { container } = render(
      <DonutChart
        data={[
          { label: "A", value: 5, color: "red" },
          { label: "B", value: undefined as unknown as number, color: "blue" },
        ]}
      />
    );

    // Total is 5, not NaN, and the zero-length arc still gets its own segment.
    expect(container.querySelector(".text-2xl")!.textContent).toBe("5");
    const [, ...segments] = [...container.querySelectorAll("circle")];
    expect(Number(segments[1]!.getAttribute("stroke-dasharray")!.split(" ")[0])).toBe(0);
  });
});

describe("BarList", () => {
  it("scales every bar against the largest value", () => {
    const { container } = render(
      <BarList
        data={[
          { label: "Acme", value: 40 },
          { label: "Globex", value: 10 },
        ]}
      />
    );
    const bars = [...container.querySelectorAll<HTMLDivElement>("div[style*='width']")];

    expect(bars[0]!.style.width).toBe("100%");
    expect(bars[1]!.style.width).toBe("25%");
  });

  it("does not divide by zero when every value is zero", () => {
    const { container } = render(<BarList data={[{ label: "Acme", value: 0 }]} />);
    const bar = container.querySelector<HTMLDivElement>("div[style*='width']");

    expect(bar!.style.width).toBe("0%");
  });

  it("shows the caller's empty label", () => {
    render(<BarList data={[]} emptyLabel="No plans assigned" />);

    expect(screen.getByText("No plans assigned")).toBeInTheDocument();
  });
});

describe("Sparkline", () => {
  it("draws one point per sample, scaled to the largest", () => {
    const { container } = render(<Sparkline data={[0, 5, 10]} width={100} height={20} />);
    const line = container.querySelectorAll("path")[1]!;
    const points = line.getAttribute("d")!.replace("M ", "").split(" L ");

    expect(points).toHaveLength(3);
    // x steps evenly across the full width…
    expect(Number(points[0]!.split(",")[0])).toBeCloseTo(0, 6);
    expect(Number(points[2]!.split(",")[0])).toBeCloseTo(100, 6);
    // …and the largest sample sits at the top (y is smallest there).
    const ys = points.map((p) => Number(p.split(",")[1]));
    expect(ys[2]!).toBeLessThan(ys[0]!);
  });

  it("renders a placeholder rather than a line for fewer than two samples", () => {
    const { container } = render(<Sparkline data={[7]} />);

    expect(container.querySelectorAll("path")).toHaveLength(0);
  });
});

describe("AreaTrend", () => {
  const originalWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");

  afterEach(() => {
    if (originalWidth) Object.defineProperty(HTMLElement.prototype, "clientWidth", originalWidth);
  });

  function withWidth(px: number) {
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get: () => px,
    });
  }

  const series = [
    { label: "Jan", value: 1 },
    { label: "Feb", value: 2 },
    { label: "Mar", value: 4 },
  ];

  it("spans the measured width and puts the peak at the top", () => {
    withWidth(400);
    const { container } = render(<AreaTrend data={series} height={200} />);
    const line = container.querySelectorAll("path")[1]!;
    const points = line.getAttribute("d")!.replace("M ", "").split(" L ");

    expect(points).toHaveLength(3);
    const xs = points.map((p) => Number(p.split(",")[0]));
    const ys = points.map((p) => Number(p.split(",")[1]));
    // 8px of horizontal padding at each end.
    expect(xs[0]!).toBeCloseTo(8, 6);
    expect(xs[2]!).toBeCloseTo(392, 6);
    // The largest value is drawn highest.
    expect(ys[2]!).toBeLessThan(ys[1]!);
    expect(ys[1]!).toBeLessThan(ys[0]!);
  });

  it("gives each instance its own gradient id, so two charts cannot collide", () => {
    withWidth(400);
    const { container } = render(
      <>
        <AreaTrend data={series} />
        <AreaTrend data={series} />
      </>
    );
    const ids = [...container.querySelectorAll("linearGradient")].map((g) => g.id);

    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it("renders the empty state for an empty series", () => {
    withWidth(400);
    render(<AreaTrend data={[]} />);

    expect(screen.getByText(/no data/i)).toBeInTheDocument();
  });
});

describe("ChartCard", () => {
  it("renders its title, subtitle, action and body", () => {
    render(
      <ChartCard title="Tenant growth" subtitle="last 6 months" action={<button>Export</button>}>
        <p>body</p>
      </ChartCard>
    );

    expect(screen.getByText("Tenant growth")).toBeInTheDocument();
    expect(screen.getByText("last 6 months")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export" })).toBeInTheDocument();
    expect(screen.getByText("body")).toBeInTheDocument();
  });
});
