/**
 * The site popup's counts are doors (SCRUM-311): Cameras, Offline and Alarms each
 * open the list they were counted from, filtered to the site.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { SitePublic } from "@/lib/types";

import SiteCard from "./SiteCard";

const SITE = { site_id: "s1", name: "Gvd gurugram", threat_level: "normal" } as unknown as SitePublic;
const OPS = { devices: 3, cameras: 2, offline: 1, alarms: 0 };

describe("the counts", () => {
  it("open the site's cameras, its offline cameras and its open alarms", () => {
    render(<SiteCard site={SITE} ops={OPS} />);

    expect(screen.getByRole("link", { name: /2\s*cameras/i })).toHaveAttribute(
      "href",
      "/devices/cameras?site=s1",
    );
    expect(screen.getByRole("link", { name: /1\s*offline/i })).toHaveAttribute(
      "href",
      "/devices/cameras?site=s1&status=not_online",
    );
    expect(screen.getByRole("link", { name: /0\s*alarms/i })).toHaveAttribute(
      "href",
      "/events?site=s1&ack=false",
    );
  });

  it("stay plain numbers where leaving the page would cost the operator their work", () => {
    render(<SiteCard site={SITE} ops={OPS} drillDown={false} showAlarms={false} />);
    expect(screen.queryByRole("link", { name: /cameras/i })).not.toBeInTheDocument();
    expect(screen.getByText("Cameras")).toBeInTheDocument();
  });
});
