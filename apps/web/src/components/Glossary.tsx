import { copy } from "../copy";
import { usePrinting } from "../lib/print";
import { SecurityBlock } from "./SecurityParts";

const c = copy.security.glossary;

/** Plain meanings for the terms used on the page, in a native disclosure that opens by itself when printing. */
export function Glossary() {
  const printing = usePrinting();
  return (
    <SecurityBlock id="security-glossary" title={c.title} lede={c.lede}>
      <details className="card glossary" open={printing ? true : undefined}>
        <summary>{c.summary}</summary>
        <dl className="glossary-list">
          {c.terms.map((entry) => (
            <div key={entry.term}>
              <dt>{entry.term}</dt>
              <dd>{entry.meaning}</dd>
            </div>
          ))}
        </dl>
      </details>
    </SecurityBlock>
  );
}
