import { copy } from "../copy";
import { SecurityBlock } from "./SecurityParts";

const c = copy.security.glossary;

/** Plain meanings for the terms used on the page, in a native disclosure that prints as it shows on screen. */
export function Glossary() {
  return (
    <SecurityBlock id="security-glossary" title={c.title} lede={c.lede}>
      <details className="card glossary">
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
