import { useState, type ReactNode } from "react";
import { copy } from "../copy";
import { LIST_LIMIT } from "../lib/space";

interface ShowAllListProps {
  /** How many entries there are in all. */
  total: number;
  /** Renders the entries, given how many to show. */
  children: (limit: number) => ReactNode;
  limit?: number;
}

/**
 * Shows the first entries of a long list and offers the rest behind a button. The label changes to say what the
 * next press does, so the button carries no aria-expanded, which would announce the same thing twice.
 */
export function ShowAllList({ total, children, limit = LIST_LIMIT }: ShowAllListProps) {
  const [all, setAll] = useState(false);
  const collapsible = total > limit;
  return (
    <>
      {children(all || !collapsible ? total : limit)}
      {collapsible && (
        <button type="button" className="button button-ghost" onClick={() => setAll((value) => !value)}>
          {all ? copy.space.showFewer : copy.space.showAll(total)}
        </button>
      )}
    </>
  );
}
