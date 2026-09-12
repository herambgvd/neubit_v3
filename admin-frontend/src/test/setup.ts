import "@testing-library/jest-dom/vitest";

import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// jsdom implements neither of these, and Radix + the charts use both.
class ResizeObserverStub {
  // Nothing to observe: jsdom has no layout, so no box ever resizes. Radix and
  // the charts only need the constructor and these methods to exist.
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverStub);

// jsdom implements no layout, so it has no scrollIntoView. The command palette
// calls it to keep the highlighted row visible.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
}

if (!window.matchMedia) {
  vi.stubGlobal(
    "matchMedia",
    (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })
  );
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
});
