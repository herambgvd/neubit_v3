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
// `releaseSlot()` the moment that connection SETTLES (playing, terminal failure,
// or unmount). Freed slots are handed FIFO to the next waiting tile.
//
// Framework-free by design (no React): a single shared module-level gate governs
// every LivePlayer instance on the page.

// Max concurrent "connecting" slots. 4–6 is the right range: enough to keep the
// wall filling briskly, low enough that the NVR never sees a burst it rejects.
const MAX = 4;

let active = 0; // slots currently held (a connection is establishing)
const waiters = []; // FIFO queue of resolve fns awaiting a slot

// Acquire a connecting slot. Resolves immediately if one is free; otherwise
// queues and resolves (FIFO) when a slot is released.
export function acquireSlot() {
  if (active < MAX) {
    active += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    waiters.push(resolve);
  });
}

// Release a slot. If tiles are queued, hand this slot straight to the next one
// (active stays the same — ownership just transfers). Otherwise free the slot
// (decrement active, never below 0).
export function releaseSlot() {
  if (waiters.length > 0) {
    const next = waiters.shift();
    next();
    return;
  }
  if (active > 0) active -= 1;
}

// Current max — exported so callers/tests can read the configured ceiling.
export const MAX_CONNECTING = MAX;
