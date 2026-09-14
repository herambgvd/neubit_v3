// connectGate — a tiny module-level async concurrency semaphore that bounds how
// many stream connections may be ESTABLISHING at the same instant.
//
// Why this exists (confirmed on real hardware): the Video Wall mounts up to 25
// LivePlayer tiles at once. Each tile immediately opens a WebRTC/WHEP connection,
// which triggers an on-demand RTSP pull from the NVR. Firing ~16 of those in a
// burst blows past the NVR's concurrent-connection ceiling → it refuses / times
// out (`RTSP source stopped: timed out`, `invalid SDP: no media streams`) → the
// whole wall cascades into stuck "Starting stream…" tiles.
//
// The fix is NOT to cap how many streams play — it's to cap how many are forming
// AT ONCE, so connections establish a few at a time and stay under the NVR's
// transient limit. A tile calls `acquireSlot()` before it starts connecting and
// releases its slot the moment that connection SETTLES (playing, terminal
// failure, or unmount). Freed slots are handed FIFO to the next waiting tile.
//
// Why the API is a HANDLE and not a bare promise + a global `releaseSlot()`:
// that earlier shape made "release" mean two different things depending on a
// race the caller had to track by hand — a tile that unmounts while still
// QUEUED never held a slot, so releasing it handed a slot to another waiter
// WITHOUT charging it against `active`. Every such unmount raised the real
// ceiling by one, and on a 25-tile wall (21 tiles queued at any instant) a
// shift's worth of layout changes and pattern rotations walked the ceiling far
// past MAX — which looks, from the outside, exactly like a failing recorder.
// One call site got it right and one did not, so the gate now owns the
// distinction: a handle knows whether it is still queued or actually holding,
// and `release()` does the right thing either way, exactly once.
//
// Framework-free by design (no React): a single shared module-level gate governs
// every LivePlayer instance on the page.

// Max concurrent "connecting" slots. 4–6 is the right range: enough to keep the
// wall filling briskly, low enough that the NVR never sees a burst it rejects.
const MAX = 4;

let active = 0; // slots currently held (a connection is establishing)
const waiters: Array<() => void> = []; // FIFO queue of grant fns awaiting a slot

/** One tile's claim on a connecting slot. Cancellable while still queued. */
export interface ConnectSlot {
  /** Resolves when this tile owns a slot and may start connecting. */
  readonly granted: Promise<void>;
  /**
   * Give the claim back. Idempotent, and safe at any point in the slot's life:
   * while still queued it simply leaves the queue (nothing was ever held, so
   * nothing is handed on); once granted it passes ownership to the next waiter.
   */
  release(): void;
}

/**
 * Claim a connecting slot. `granted` resolves immediately when a slot is free
 * (single-camera view → no user-visible delay); otherwise the claim queues and
 * is granted FIFO as slots come back.
 */
export function acquireSlot(): ConnectSlot {
  let state: "queued" | "held" | "released" = "queued";
  let grant!: () => void;
  const granted = new Promise<void>((resolve) => {
    grant = () => {
      // The flip to "held" is SYNCHRONOUS with the hand-off, not with the
      // caller's `.then` — otherwise a release landing in between would be
      // treated as a still-queued cancel and the slot would vanish.
      state = "held";
      resolve();
    };
  });

  if (active < MAX) {
    active += 1;
    grant();
  } else {
    waiters.push(grant);
  }

  return {
    granted,
    release() {
      if (state === "released") return;
      if (state === "queued") {
        const at = waiters.indexOf(grant);
        if (at >= 0) waiters.splice(at, 1);
        state = "released";
        return;
      }
      state = "released";
      handOn();
    },
  };
}

// Free one held slot: straight to the next waiting tile if there is one
// (`active` stays the same — ownership just transfers), otherwise back to the
// pool.
function handOn() {
  const next = waiters.shift();
  if (next) {
    next();
    return;
  }
  if (active > 0) active -= 1;
}

// Current max — exported so callers/tests can read the configured ceiling.
export const MAX_CONNECTING = MAX;
