import { useState, type ReactNode } from "react";
import { copy } from "../copy";
import { usePrinting } from "../lib/print";
import { LIST_LIMIT } from "../lib/space";

interface ShowAllListProps {
  /** How many entries there are in all. */
  total: number;
  /** Renders the entries, given how many to show. */
  children: (limit: number) => ReactNode;
  limit?: number;
  /**
   * True, the default, prints every entry. False prints what the screen shows, so a list left collapsed prints only its
   * first entries, followed by a line saying how many more there are.
   */
  printAll?: boolean;
  /** The printed line saying how many entries are left out, given that number. Only used when `printAll` is false. */
  printNote?: (hidden: number) => string;
  /**
   * Names the list, either as a plural noun phrase for what it holds, such as "least covered files", or as which check
   * it belongs to, as `copy.space.forCheck` gives it. The button's accessible name begins with its visible text and goes
   * on to name the list, so a person using voice control can say what they see (WCAG 2.5.3 Label in Name).
   */
  what: string;
}

/**
 * Shows the first entries of a long list and offers the rest behind a button. The label changes to say what the
 * next press does, so the button carries no aria-expanded, which would announce the same thing twice. By default the
 * printed report carries every entry and no button, since a reader of the PDF cannot press it. A page whose printed
 * copy should look like the screen passes `printAll={false}`.
 */
export function ShowAllList({
  total,
  children,
  limit = LIST_LIMIT,
  printAll = true,
  printNote = copy.space.printMore,
  what,
}: ShowAllListProps) {
  const [all, setAll] = useState(false);
  const printing = usePrinting();
  const overLimit = total > limit;
  const printingAll = printing && printAll;
  const collapsible = overLimit && !printingAll;
  const expanded = all || !collapsible;
  return (
    <>
      {children(expanded ? total : limit)}
      {collapsible && (
        <button
          type="button"
          className="button button-ghost screen-only"
          aria-label={all ? copy.space.showFewerOf(what) : copy.space.showAllOf(total, what)}
          onClick={() => setAll((value) => !value)}
        >
          {all ? copy.space.showFewer : copy.space.showAll(total)}
        </button>
      )}
      {!printAll && overLimit && !all && <p className="print-only">{printNote(total - limit)}</p>}
    </>
  );
}
