/**
 * A console names itself ONCE, in the top bar.
 *
 * Live and Devices put their name beside the brand as a badge and start their
 * page on content. Pulse shipped with both — a badge-less page under an
 * EstateHeader carrying "Pulse" and a paragraph explaining the screen — which is
 * a heading and a subtitle occupying the top of a board whose whole job is to be
 * scanned at a glance.
 *
 * So: the badge is in the bar, and a section with no sub-tabs renders the badge
 * ALONE — an empty pill box beside it reads as a control that lost its contents.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import SectionTabs from "./SectionTabs";
import HeaderSectionNav from "./HeaderSectionNav";

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ can: () => true, hasModule: () => true, user: { id: "me" } }),
}));

let pathname = "/pulse";
vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
  useSearchParams: () => new URLSearchParams(""),
}));

describe("the section badge", () => {
  it("names Pulse in the top bar", () => {
    pathname = "/pulse";
    render(<HeaderSectionNav />);
    expect(screen.getByText("Pulse")).toBeInTheDocument();
  });

  it("renders nothing on a route with no section nav", () => {
    pathname = "/events";
    const { container } = render(<HeaderSectionNav />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows a label with no tabs as a badge alone", () => {
    render(<SectionTabs tabs={[]} label="Pulse" icon="heroicons:heart" />);
    expect(screen.getByText("Pulse")).toBeInTheDocument();
    expect(screen.queryByRole("navigation")).toBeNull();
  });

  it("still renders the tab group for a section that has one", () => {
    render(
      <SectionTabs
        tabs={[{ title: "Playback", icon: "heroicons:play", link: "/playback" }]}
        label="Streaming"
        icon="heroicons:signal"
      />,
    );
    expect(screen.getByRole("navigation")).toBeInTheDocument();
    expect(screen.getByText("Playback")).toBeInTheDocument();
  });
});
