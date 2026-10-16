import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
import { StickyPanel } from "./StickyPanel";

/** The height of the content, which is what the panel is judged on. The pinned panel adds its padding and border to it. */
let panelHeight = 200;
const PINNED_EXTRA = 29;
let observed: (() => void)[] = [];
const originalHeight = window.innerHeight;

beforeEach(() => {
  panelHeight = 200;
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains("sticky-panel-body")) return panelHeight;
    if (this.classList.contains("sticky-panel"))
      return panelHeight + (this.classList.contains("sticky-panel-pinned") ? PINNED_EXTRA : 0);
    return 0;
  });
  observed = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        observed.push(callback);
      }
      observe() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Object.defineProperty(window, "innerHeight", { configurable: true, value: originalHeight });
});

function renderPanel() {
  const { container } = render(
    <div>
      <StickyPanel>
        <h1>Title</h1>
      </StickyPanel>
    </div>,
  );
  const page = container.firstElementChild as HTMLElement;
  return { page, panel: page.querySelector(".sticky-panel") as HTMLElement };
}

describe("StickyPanel", () => {
  it("is pinned, and publishes its height, when it takes no more than 40% of the window", () => {
    // 200 of 800 is 25%.
    const { page, panel } = renderPanel();
    expect(panel).toHaveClass("sticky-panel-pinned");
    expect(page.style.getPropertyValue("--sticky-panel-height")).toBe("229px");
  });

  it("is left in the flow, and publishes nothing, when it takes more than 40% of the window", () => {
    panelHeight = 400; // 400 of 800 is half.
    const { page, panel } = renderPanel();
    expect(panel).not.toHaveClass("sticky-panel-pinned");
    expect(page.style.getPropertyValue("--sticky-panel-height")).toBe("");
  });

  it("is pinned at exactly 40%", () => {
    panelHeight = 320;
    expect(renderPanel().panel).toHaveClass("sticky-panel-pinned");
  });

  it("is re-judged when the window is resized", () => {
    const { page, panel } = renderPanel();
    expect(panel).toHaveClass("sticky-panel-pinned");
    act(() => {
      Object.defineProperty(window, "innerHeight", { configurable: true, value: 400 });
      fireEvent(window, new Event("resize"));
    });
    expect(panel).not.toHaveClass("sticky-panel-pinned");
    expect(page.style.getPropertyValue("--sticky-panel-height")).toBe("");
    act(() => {
      Object.defineProperty(window, "innerHeight", { configurable: true, value: 1000 });
      fireEvent(window, new Event("resize"));
    });
    expect(panel).toHaveClass("sticky-panel-pinned");
    expect(page.style.getPropertyValue("--sticky-panel-height")).toBe("229px");
  });

  it("stays pinned when the body sits exactly at the threshold, however often it is observed", () => {
    panelHeight = 320; // The body is exactly 40% of 800, and the pinned panel is 29px taller than that.
    const { page, panel } = renderPanel();
    expect(panel).toHaveClass("sticky-panel-pinned");
    for (let round = 0; round < 5; round += 1) {
      act(() => observed.forEach((callback) => callback()));
      expect(panel).toHaveClass("sticky-panel-pinned");
    }
    expect(page.style.getPropertyValue("--sticky-panel-height")).toBe("349px");
  });

  it("clears the property and stops listening to the window when it goes", () => {
    const { container, unmount } = render(
      <div>
        <StickyPanel>
          <h1>Title</h1>
        </StickyPanel>
      </div>,
    );
    const page = container.firstElementChild as HTMLElement;
    expect(page.style.getPropertyValue("--sticky-panel-height")).toBe("229px");
    const remove = vi.spyOn(window, "removeEventListener");
    unmount();
    expect(remove).toHaveBeenCalledWith("resize", expect.any(Function));
    expect(page.style.getPropertyValue("--sticky-panel-height")).toBe("");
  });
});
