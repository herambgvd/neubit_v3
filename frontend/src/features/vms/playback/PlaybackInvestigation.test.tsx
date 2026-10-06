/** @vitest-environment jsdom */
/**
 * The investigation panel (SCRUM-307): every row is a jump, and a bookmark is
 * written to the recorder that owns the camera.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { createClock } from "../hooks/useWallPlayback";
import PlaybackInvestigation, { type PlaybackInvestigationProps } from "./PlaybackInvestigation";

const AT = new Date(2026, 9, 6, 10, 0, 0).getTime();

function props(over: Partial<PlaybackInvestigationProps> = {}): PlaybackInvestigationProps {
  return {
    clock: createClock(),
    activeCamName: "Gate",
    events: [{ key: "e1", camKey: "fed:n:1", camName: "Gate", at: AT, type: "motion" }],
    bookmarks: [{ id: "b1", camKey: "fed:n:1", camName: "Gate", nodeId: "n", at: AT + 60_000, label: "Van arrives" }],
    bookmarksFailed: false,
    motion: null,
    exportsList: [],
    canExportAll: false,
    selectionText: null,
    onSeek: vi.fn(),
    onAddBookmark: vi.fn(async () => true),
    onDeleteBookmark: vi.fn(),
    onMotionSearch: vi.fn(),
    onClearMotion: vi.fn(),
    onExportAll: vi.fn(),
    onDownload: vi.fn(),
    onClose: vi.fn(),
    ...over,
  };
}

describe("PlaybackInvestigation", () => {
  it("jumps a few seconds before an event, on its camera", () => {
    const p = props();
    render(<PlaybackInvestigation {...p} />);
    fireEvent.click(screen.getByText("motion"));
    expect(p.onSeek).toHaveBeenCalledWith(AT - 5_000, "fed:n:1");
  });

  it("adds a bookmark with its label and clears the form", async () => {
    const p = props();
    render(<PlaybackInvestigation {...p} />);
    fireEvent.click(screen.getByRole("tab", { name: /Bookmarks/ }));
    expect(screen.getByText("Van arrives")).toBeInTheDocument();
    const label = screen.getByLabelText("Bookmark label");
    fireEvent.change(label, { target: { value: "  Door forced  " } });
    fireEvent.click(screen.getByRole("button", { name: "Add bookmark" }));
    await waitFor(() => expect(p.onAddBookmark).toHaveBeenCalledWith("Door forced", ""));
    await waitFor(() => expect(label).toHaveValue(""));
  });

  it("says why bookmarks are missing on a recorder paired before they were shared", () => {
    render(<PlaybackInvestigation {...props({ bookmarksFailed: true })} />);
    fireEvent.click(screen.getByRole("tab", { name: /Bookmarks/ }));
    expect(screen.getByText(/needs a\s+re-pair/)).toBeInTheDocument();
  });

  it("deletes a bookmark without seeking to it", () => {
    const p = props();
    render(<PlaybackInvestigation {...p} />);
    fireEvent.click(screen.getByRole("tab", { name: /Bookmarks/ }));
    fireEvent.click(screen.getByRole("button", { name: "Delete bookmark Van arrives" }));
    expect(p.onDeleteBookmark).toHaveBeenCalled();
    expect(p.onSeek).not.toHaveBeenCalled();
  });

  it("only exports the grid once a range is marked, and offers finished clips for download", () => {
    const p = props({
      exportsList: [
        { id: "x1", nodeId: "n", camName: "Gate", from: new Date(AT).toISOString(), to: new Date(AT + 30_000).toISOString(), status: "done" },
        { id: "x2", nodeId: "n", camName: "Yard", from: new Date(AT).toISOString(), to: new Date(AT + 30_000).toISOString(), status: "running" },
      ],
    });
    render(<PlaybackInvestigation {...p} />);
    fireEvent.click(screen.getByRole("tab", { name: /Exports/ }));
    expect(screen.getByRole("button", { name: /Export every camera/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Download the Gate clip" }));
    expect(p.onDownload).toHaveBeenCalledWith(expect.objectContaining({ id: "x1" }));
    expect(screen.queryByRole("button", { name: "Download the Yard clip" })).toBeNull();
  });

  it("lists motion hits and jumps to them", () => {
    const p = props({ motion: { camName: "Gate", hits: [{ s: AT, e: AT + 4_000, score: 0.8 }], note: "" } });
    render(<PlaybackInvestigation {...p} />);
    fireEvent.click(screen.getByRole("tab", { name: /Motion/ }));
    fireEvent.click(screen.getByText("4s"));
    expect(p.onSeek).toHaveBeenCalledWith(AT - 2_000);
  });
});
