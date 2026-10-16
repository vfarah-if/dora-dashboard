import { useLayoutEffect, useRef, type ReactNode } from "react";

/** The most of the window's height the panel may take and still be held in place. A taller one scrolls away with the page. */
const PIN_SHARE = 0.4;

/**
 * The top of a page (back link, title, actions and controls) held under the app header while the rest of
 * the page scrolls beneath it, so long as it leaves most of the window for the content. A panel that would
 * take more than `PIN_SHARE` of the window's height stays in the flow. Whenever the body fits, the panel's height is
 * published as `--sticky-panel-height` on the page, so anything else that sticks further down (the fairness panel on
 * Compare) can sit below it instead of under it; otherwise the property is absent and that offset is zero. The
 * stylesheet holds the panel in place only from 720px wide, so on a phone the property is set but nothing sticks.
 */
export function StickyPanel({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const panel = ref.current;
    const page = panel?.parentElement;
    const body = bodyRef.current;
    if (!panel || !body || !page) return;
    const update = () => {
      // The body is measured, not the panel, because the panel grows by its padding and border once pinned.
      const pinned = body.offsetHeight <= window.innerHeight * PIN_SHARE;
      panel.classList.toggle("sticky-panel-pinned", pinned);
      if (pinned) page.style.setProperty("--sticky-panel-height", `${panel.offsetHeight}px`);
      else page.style.removeProperty("--sticky-panel-height");
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(body);
    window.addEventListener("resize", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
      page.style.removeProperty("--sticky-panel-height");
    };
  }, []);

  return (
    <div ref={ref} className="sticky-panel">
      <div ref={bodyRef} className="sticky-panel-body">
        {children}
      </div>
    </div>
  );
}
