/**
 * The box that stops an operator dragging the world. The rule worth pinning is
 * the difference between the two query kinds: a NAME only flies the map, because
 * a city centre is not a site, while a pasted COORDINATE is the exact point and
 * drops the pin. Getting that backwards silently saves city centres as sites.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { resetGazetteer } from "@/lib/map/gazetteer";

import PlaceSearch from "./PlaceSearch";

const TSV = [
  "Mumbai\tMaharashtra\tIndia\t19.0728\t72.8826\t12691836",
  "Delhi\tDelhi\tIndia\t28.6667\t77.2167\t10927986",
  "New Delhi\tDelhi\tIndia\t28.6214\t77.2148\t317797",
].join("\n");

let onGo: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetGazetteer();
  onGo = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(TSV, { status: 200 })));
});

const box = () => screen.getByRole("textbox", { name: /search for a place/i });

describe("PlaceSearch", () => {
  it("fetches nothing until there is a real query", async () => {
    render(<PlaceSearch onGo={onGo} />);
    await userEvent.click(box());
    await userEvent.type(box(), "m");

    expect(fetch).not.toHaveBeenCalled();
  });

  it("flies to a place WITHOUT dropping the pin", async () => {
    render(<PlaceSearch onGo={onGo} />);
    await userEvent.type(box(), "new de");

    const hit = await screen.findByText("New Delhi");
    await userEvent.click(hit);

    expect(onGo).toHaveBeenCalledWith(
      expect.objectContaining({ lat: 28.6214, lng: 77.2148, drop: false }),
    );
  });

  it("drops the pin for a pasted coordinate, which IS the exact point", async () => {
    render(<PlaceSearch onGo={onGo} />);
    await userEvent.type(box(), "28.6139, 77.2090");

    await userEvent.click(await screen.findByText(/Go to 28\.613900, 77\.209000/));

    expect(onGo).toHaveBeenCalledWith({ lat: 28.6139, lng: 77.209, zoom: 16, drop: true });
    expect(fetch).not.toHaveBeenCalled(); // a coordinate needs no place list
  });

  it("takes Enter on the highlighted row, and Arrow keys to move it", async () => {
    render(<PlaceSearch onGo={onGo} />);
    await userEvent.type(box(), "delhi");
    await screen.findByText("New Delhi");

    await userEvent.keyboard("{ArrowDown}{Enter}");

    // "delhi" ranks exact-name Delhi first; one step down is the next result.
    expect(onGo).toHaveBeenCalledTimes(1);
    expect(onGo.mock.calls[0][0].drop).toBe(false);
    expect(onGo.mock.calls[0][0].lat).not.toBe(28.6667);
  });

  it("says so when the place list is not installed, instead of looking broken", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 404 })));
    render(<PlaceSearch onGo={onGo} />);
    await userEvent.type(box(), "delhi");

    expect(await screen.findByText(/Place list not installed/i)).toBeInTheDocument();
  });

  it("reports an honest miss rather than an empty box", async () => {
    render(<PlaceSearch onGo={onGo} />);
    await userEvent.type(box(), "zzzqqq");

    expect(await screen.findByText(/No place matched/i)).toBeInTheDocument();
  });

  it("clears back to nothing", async () => {
    render(<PlaceSearch onGo={onGo} />);
    await userEvent.type(box(), "delhi");
    await screen.findByText("New Delhi");

    await userEvent.click(screen.getByRole("button", { name: /clear search/i }));

    expect(box()).toHaveValue("");
    await waitFor(() => expect(screen.queryByText("New Delhi")).not.toBeInTheDocument());
  });
});
