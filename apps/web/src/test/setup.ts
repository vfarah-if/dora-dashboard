import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

/**
 * jsdom has no layout engine. Recharts' ResponsiveContainer measures itself with ResizeObserver, so the
 * stub reports a fixed size straight away, which lets charts render their SVG in tests.
 */
class ResizeObserverStub {
  private readonly callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }

  observe(target: Element) {
    const entry = { target, contentRect: { width: 800, height: 300, top: 0, left: 0, bottom: 300, right: 800, x: 0, y: 0 } };
    this.callback([entry as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
  }

  unobserve() {}

  disconnect() {}
}

globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 800 });
Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 300 });

if (!window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("data-theme");
  try {
    window.localStorage.clear();
  } catch {
    // Ignore storage being unavailable.
  }
});
