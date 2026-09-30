import { useLayoutEffect, useRef, type ReactNode } from "react";

/**
 * The top of a page (back link, title, actions and controls) held under the app header while the rest of
 * the page scrolls beneath it. Its height is published as `--sticky-panel-height` on the page, so anything
 * else that sticks further down (the fairness panel on Compare) can sit below it instead of under it.
 */
export function StickyPanel({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const panel = ref.current;
    const page = panel?.parentElement;
    if (!panel || !page) return;
    const publish = () => page.style.setProperty("--sticky-panel-height", `${panel.offsetHeight}px`);
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(panel);
    return () => {
      observer.disconnect();
      page.style.removeProperty("--sticky-panel-height");
    };
  }, []);

  return (
    <div ref={ref} className="sticky-panel">
      {children}
    </div>
  );
}
