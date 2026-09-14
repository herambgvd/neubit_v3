// The gate is module-level state shared by every tile on the page, so each test
// loads a FRESH copy — otherwise one test's leftover waiters set the next one's
// starting conditions and a real regression can hide behind a passing run.
import { beforeEach, describe, expect, it, vi } from "vitest";

type Gate = typeof import("./connectGate");

let gate: Gate;

interface WallState {
  connecting: number;
  peak: number;
  order: string[];
}

/** Let every queued `.then` run — grants are handed on through microtasks. */
const flush = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

/**
 * A tile modelled on the real call sites: claim a slot, start "connecting" when
 * it is granted, and give the claim back on unmount whatever state it is in.
 * `state` records how many are connecting at once, which is the only number the
 * NVR actually cares about.
 */
function mountTile(state: WallState, name = "") {
  let disposed = false;
  let connecting = false;
  const slot = gate.acquireSlot();
  const started = slot.granted.then(() => {
    if (disposed) return;
    connecting = true;
    state.connecting += 1;
    state.peak = Math.max(state.peak, state.connecting);
    state.order.push(name);
  });
  const stop = () => {
    if (connecting) {
      connecting = false;
      state.connecting -= 1;
    }
    slot.release();
  };
  return {
    started,
    /** The connection settled normally — still playing, slot handed on. */
    settle: stop,
    unmount() {
      disposed = true;
      stop();
    },
  };
}

const newState = (): WallState => ({ connecting: 0, peak: 0, order: [] });

beforeEach(async () => {
  vi.resetModules();
  gate = await import("./connectGate");
});

describe("connectGate", () => {
  it("keeps a healthy wall filling MAX_CONNECTING at a time", async () => {
    const state = newState();
    Array.from({ length: gate.MAX_CONNECTING * 3 }, () => mountTile(state));
    await flush();
    expect(state.connecting).toBe(gate.MAX_CONNECTING);
    expect(state.peak).toBe(gate.MAX_CONNECTING);
  });

  it("never exceeds MAX_CONNECTING when a tile unmounts while still queued", async () => {
    // The wall regression: a queued tile holds nothing, so giving its claim back
    // must not promote a waiter. It used to, without charging the promotion
    // against the pool — every layout change on a 25-tile wall raised the real
    // ceiling by one until the recorder started refusing connections.
    const state = newState();
    const tiles = Array.from({ length: gate.MAX_CONNECTING * 2 }, () => mountTile(state));
    await flush();
    expect(state.peak).toBe(gate.MAX_CONNECTING);

    // Unmount tiles that are still QUEUED, and not the head of the queue — the
    // head's own resolver is the one a bad release would shift and waste.
    tiles[gate.MAX_CONNECTING + 2].unmount();
    tiles[gate.MAX_CONNECTING + 3].unmount();
    await flush();

    expect(state.peak).toBeLessThanOrEqual(gate.MAX_CONNECTING);
    expect(state.connecting).toBe(gate.MAX_CONNECTING);
  });

  it("hands a normally released slot to the next waiter, FIFO", async () => {
    const state = newState();
    const tiles = Array.from({ length: gate.MAX_CONNECTING + 3 }, (_, i) =>
      mountTile(state, `t${i}`),
    );
    await flush();
    expect(state.order).toEqual(
      Array.from({ length: gate.MAX_CONNECTING }, (_, i) => `t${i}`),
    );

    tiles[0].settle();
    await flush();
    expect(state.order.at(-1)).toBe(`t${gate.MAX_CONNECTING}`);

    tiles[1].settle();
    await flush();
    expect(state.order.at(-1)).toBe(`t${gate.MAX_CONNECTING + 1}`);
    expect(state.connecting).toBe(gate.MAX_CONNECTING);
  });

  it("still lets MAX_CONNECTING tiles connect after a churn of queued unmounts", async () => {
    // The other half of the same bug: a dropped claim whose release was lost
    // left `active` permanently charged for a tile that no longer exists, so the
    // pool shrank with every rotation until nothing could open at all.
    const state = newState();
    const churn = Array.from({ length: gate.MAX_CONNECTING * 3 }, () => mountTile(state));
    await flush();
    // Tear the whole wall down — connecting tiles and queued ones alike, in the
    // arbitrary order a React unmount gives.
    for (const tile of [...churn].reverse()) tile.unmount();
    await flush();
    expect(state.connecting).toBe(0);

    // A fresh layout must get the full pool back.
    const after = newState();
    Array.from({ length: gate.MAX_CONNECTING * 2 }, () => mountTile(after));
    await flush();
    expect(after.connecting).toBe(gate.MAX_CONNECTING);
  });
});
