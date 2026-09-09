"use client";

// A clock that re-renders its caller on an interval — for the things whose value
// is "how long has this been true", which change with no event to drive them.
//
// One timer per caller, cleared on unmount. Nothing here is a data fetch: the
// duration of an open event is arithmetic on a timestamp we already hold, so
// ticking costs a render and no request.
import { useEffect, useState } from "react";

export function useTicker(intervalMs = 1_000, enabled = true): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, enabled]);

  return now;
}

export default useTicker;
