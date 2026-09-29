import { useEffect, useState } from "react";
import { flushSync } from "react-dom";

/**
 * True while the browser is printing, so a component can render its full content for the printed copy
 * (for example every page of a paged table). The update on beforeprint is flushed synchronously because
 * the browser lays out the printed pages as soon as the event returns.
 */
export function usePrinting(): boolean {
  const [printing, setPrinting] = useState(false);

  useEffect(() => {
    const before = () => flushSync(() => setPrinting(true));
    const after = () => setPrinting(false);
    window.addEventListener("beforeprint", before);
    window.addEventListener("afterprint", after);
    return () => {
      window.removeEventListener("beforeprint", before);
      window.removeEventListener("afterprint", after);
    };
  }, []);

  return printing;
}
