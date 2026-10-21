/**
 * THE WALL'S DVR (SCRUM-337) — the live wall plays back with the Playback
 * workspace's controls: its speed ladder and limits, frame step, stepped reverse,
 * zoom and pan, an IN/OUT range. What stays the wall's own is live ⇄ playback and
 * SYNC, which decides how many tiles play back — and so how fast they may go.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FRAME_MS, INSTANT_REPLAY_MS, LIVE_EDGE_LAG_MS } from "../playback/playbackModel";
import { useWallPlayback } from "./useWallPlayback";

const NOW = new Date("2026-10-21T15:00:00").getTime();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

const hook = (filledTiles = 9) => renderHook(() => useWallPlayback({ filledTiles }));

describe("entering playback", () => {
  it("never asks for footage the recorder has not written yet", () => {
    const { result } = hook();

    act(() => result.current.playAt(NOW));

    expect(result.current.isPlayback).toBe(true);
    expect(result.current.clock.get()).toBe(NOW - LIVE_EDGE_LAG_MS);
  });

  it("Play on a live wall is instant playback — the last half-minute", () => {
    const { result } = hook();

    act(() => result.current.togglePlaying());

    expect(result.current.isPlayback).toBe(true);
    expect(result.current.clock.get()).toBe(NOW - INSTANT_REPLAY_MS);
    act(() => result.current.togglePlaying());
    expect(result.current.playing).toBe(false);
  });

  it("a step back from live replays that much; a step forward from live goes nowhere", () => {
    const { result } = hook();

    act(() => result.current.skip(10));
    expect(result.current.isPlayback).toBe(false);

    act(() => result.current.skip(-60));
    expect(result.current.clock.get()).toBe(NOW - LIVE_EDGE_LAG_MS - 60_000);
  });
});

describe("speed, and what limits it", () => {
  it("one tile alone may go to 16× and reverse", () => {
    const { result } = hook(9);

    act(() => result.current.setSpeed(16));
    expect(result.current.speed).toBe(16);
    expect(result.current.canReverse).toBe(true);
    act(() => result.current.toggleReverse());
    expect(result.current.speed).toBe(-1);
  });

  it("with Sync on a nine-tile wall it is held to 4× and forward only", () => {
    const { result } = hook(9);
    act(() => result.current.playAt(NOW - 600_000));
    act(() => result.current.setSpeed(16));

    act(() => result.current.toggleSync());

    expect(result.current.speed).toBe(4);
    expect(result.current.maxSpeed).toBe(4);
    expect(result.current.canReverse).toBe(false);
    act(() => result.current.toggleReverse());
    expect(result.current.speed).toBe(1);
  });

  it("steps along the shared ladder", () => {
    const { result } = hook();
    act(() => result.current.stepSpeedBy(1));
    expect(result.current.speed).toBe(2);
    act(() => result.current.stepSpeedBy(-1));
    act(() => result.current.stepSpeedBy(-1));
    expect(result.current.speed).toBe(0.5);
  });
});

describe("frame step and reverse", () => {
  it("a frame step pauses and shows the next frame without re-anchoring the wall", () => {
    const { result } = hook();
    act(() => result.current.playAt(NOW - 600_000));
    const anchorSeq = result.current.anchorSeq;

    act(() => result.current.stepFrame(1));

    expect(result.current.playing).toBe(false);
    expect(result.current.scrubMs).toBe(NOW - 600_000 + FRAME_MS);
    expect(result.current.scrubSeq).toBe(1);
    expect(result.current.anchorSeq).toBe(anchorSeq);
  });

  it("reverse steps the playhead back at its speed, once a second", () => {
    const { result } = hook();
    act(() => result.current.playAt(NOW - 600_000));
    act(() => result.current.setSpeed(-2));

    act(() => vi.advanceTimersByTime(1_000));

    expect(result.current.clock.get()).toBe(NOW - 600_000 - 2_000);
    expect(result.current.scrubSeq).toBeGreaterThan(0);
  });
});

describe("the window", () => {
  it("dragging it stops it following the playhead; a seek gives it back", () => {
    const { result } = hook();
    act(() => result.current.playAt(NOW - 600_000));

    act(() => result.current.pan(-60_000));
    expect(result.current.follow).toBe(false);

    act(() => result.current.playAt(NOW - 300_000));
    expect(result.current.follow).toBe(true);
  });

  it("zooms around the instant under the pointer", () => {
    const { result } = hook();
    const before = result.current.win;
    const at = before.fromMs + (before.toMs - before.fromMs) / 4;

    act(() => result.current.zoom(0.5, at));

    const w = result.current.win;
    expect(w.toMs - w.fromMs).toBeCloseTo((before.toMs - before.fromMs) / 2);
    expect((at - w.fromMs) / (w.toMs - w.fromMs)).toBeCloseTo(0.25);
  });

  it("a day keeps the time of day and plays it", () => {
    const { result } = hook();
    act(() => result.current.playAt(new Date("2026-10-21T14:05:00").getTime()));

    act(() => result.current.pickDay("2026-10-20"));

    expect(result.current.clock.get()).toBe(new Date("2026-10-20T14:05:00").getTime());
    expect(result.current.isPlayback).toBe(true);
  });
});

describe("back to live", () => {
  it("drops the playhead, Sync and the speed, and frames now four-fifths across", () => {
    const { result } = hook();
    act(() => result.current.playAt(NOW - 600_000));
    act(() => result.current.toggleSync());
    act(() => result.current.setSpeed(2));

    act(() => result.current.goLive());

    expect(result.current.isPlayback).toBe(false);
    expect(result.current.sync).toBe(false);
    expect(result.current.speed).toBe(1);
    expect(result.current.clock.get()).toBeNull();
    const w = result.current.win;
    expect((Date.now() - w.fromMs) / (w.toMs - w.fromMs)).toBeCloseTo(0.8);
  });
});

describe("the IN / OUT range", () => {
  it("marks in and out at the playhead, and an out before the in is not a range", () => {
    const { result } = hook();
    act(() => result.current.playAt(NOW - 600_000));
    act(() => result.current.markIn());
    act(() => result.current.playAt(NOW - 500_000));
    act(() => result.current.markOut());
    expect(result.current.hasSel).toBe(true);
    expect(result.current.sel).toEqual({ inMs: NOW - 600_000, outMs: NOW - 500_000 });

    act(() => result.current.playAt(NOW - 700_000));
    act(() => result.current.markOut());
    expect(result.current.hasSel).toBe(false);

    act(() => result.current.select(NOW - 100_000, NOW - 200_000));
    expect(result.current.sel).toEqual({ inMs: NOW - 200_000, outMs: NOW - 100_000 });
    act(() => result.current.clearSel());
    expect(result.current.hasSel).toBe(false);
  });
});
