import "@testing-library/jest-dom/vitest";

// Side-effect import: registers the bundled Iconify collections, exactly as
// components/Providers.tsx does at runtime. Without it every <Icon> in a rendered
// component falls back to @iconify/react's HTTP loader, which sets a timer and
// then calls setState after the test file's jsdom has been torn down ("window is
// not defined" from react-dom, attributed to whichever file ran last).
import "@/lib/icons";

import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// jsdom implements none of these, and the console's UI uses all three. Components
// only need the constructor and these methods to exist.
class ResizeObserverStub {
  observe() {
    // jsdom has no layout, so no box ever resizes and no callback could ever fire.
  }
  unobserve() {
    // Nothing was ever observed, so there is no subscription to drop.
  }
  disconnect() {
    // Likewise: there is no subscription to tear down.
  }
}
vi.stubGlobal("ResizeObserver", ResizeObserverStub);

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
}

if (!window.matchMedia) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
});
