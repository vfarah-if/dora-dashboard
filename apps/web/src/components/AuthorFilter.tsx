import { useEffect, useId, useRef } from "react";
import type { AuthorChoice } from "@dora-dashboard/core";
import { copy } from "../copy";
import { excludeEveryone, toggleAuthor } from "../lib/authorFilter";

export interface AuthorFilterProps {
  choices: readonly AuthorChoice[];
  /** The logins left out, from the address, so a tick shows at once rather than when the report returns. */
  excluded: readonly string[];
  onChange: (excluded: string[]) => void;
}

/** A menu of authors to include in the report, with shortcuts to include everyone or no one. */
export function AuthorFilter({ choices, excluded, onChange }: AuthorFilterProps) {
  const menuRef = useRef<HTMLDetailsElement>(null);
  const hintId = useId();
  const included = choices.filter((choice) => !excluded.includes(choice.author)).length;

  // A disclosure stays open until toggled, so close it on a click elsewhere or on Escape, as a menu would.
  useEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const onPointer = (event: PointerEvent) => {
      if (menu.open && !menu.contains(event.target as Node)) menu.open = false;
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !menu.open) return;
      menu.open = false;
      menu.querySelector("summary")?.focus();
    };
    document.addEventListener("pointerdown", onPointer);
    menu.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      menu.removeEventListener("keydown", onKey);
    };
  }, []);

  return (
    <details ref={menuRef} className="author-filter">
      <summary className="button button-secondary author-filter-summary">
        {copy.authorFilter.summary(included, choices.length)}
      </summary>
      <div className="author-filter-menu">
        <p id={hintId} className="author-filter-hint">
          {copy.authorFilter.hint}
        </p>
        <div className="author-filter-actions">
          <button
            type="button"
            className="button button-ghost"
            disabled={included === choices.length}
            onClick={() => onChange([])}
          >
            {copy.authorFilter.all}
          </button>
          <button
            type="button"
            className="button button-ghost"
            disabled={included === 0}
            onClick={() => onChange(excludeEveryone(excluded, choices))}
          >
            {copy.authorFilter.none}
          </button>
        </div>
        <fieldset className="author-filter-list" aria-describedby={hintId}>
          <legend className="visually-hidden">{copy.authorFilter.legend}</legend>
          {choices.map((choice) => (
            <label key={choice.author} className="author-filter-option">
              <input
                type="checkbox"
                checked={!excluded.includes(choice.author)}
                onChange={(event) => onChange(toggleAuthor(excluded, choice.author, event.target.checked))}
              />
              <span className="mono">{choice.author}</span>
              <span className="author-filter-count">{copy.authorFilter.opened(choice.opened)}</span>
            </label>
          ))}
        </fieldset>
      </div>
    </details>
  );
}
