import { useEffect, useRef } from "react";
import type { Band } from "@dora-dashboard/core";
import { copy } from "../copy";
import type { DoraExplanation } from "../lib/doraExplain";
import { BandLabel } from "./BandLabel";
import { ExternalLink } from "./ExternalLink";

export interface DoraTileProps {
  title: string;
  definition: string;
  /** The formatted headline figure, or null when the measure could not be taken. */
  value: string | null;
  band: Band | null;
  detail?: string;
  /** Why the measure is missing, shown when `value` is null. */
  reason?: string;
  /** Says why there is no band, shown in its place when the measure has none. */
  noBandNote?: string;
  /** Why the band is what it is and how to move up, shown in a disclosure after the definition. */
  explanation?: DoraExplanation | null;
}

/**
 * A closed disclosure prints as its summary alone, so the printed report opens it for the length of the print and
 * puts it back as it was afterwards. Only the first `beforeprint` of a print records the state, so a browser that
 * announces the print twice does not record the disclosure as already open.
 */
function useOpenWhilePrinting(ref: React.RefObject<HTMLDetailsElement | null>) {
  useEffect(() => {
    let printing = false;
    let wasOpen = false;
    const before = () => {
      if (!printing) wasOpen = ref.current?.open ?? false;
      printing = true;
      if (ref.current) ref.current.open = true;
    };
    const after = () => {
      printing = false;
      if (ref.current) ref.current.open = wasOpen;
    };
    window.addEventListener("beforeprint", before);
    window.addEventListener("afterprint", after);
    return () => {
      window.removeEventListener("beforeprint", before);
      window.removeEventListener("afterprint", after);
    };
  }, [ref]);
}

function Explanation({ title, explanation }: { title: string; explanation: DoraExplanation }) {
  const text = copy.dora.explain;
  const ref = useRef<HTMLDetailsElement>(null);
  useOpenWhilePrinting(ref);
  return (
    <details className="table-disclosure dora-explain" ref={ref}>
      <summary>
        {text.summary}
        <span className="visually-hidden">{text.summaryMeasure(title)}</span>
      </summary>
      <div className="dora-explain-body">
        <h4>{text.meaningHeading}</h4>
        <p>
          {explanation.meaning} <ExternalLink href={explanation.source.href}>{explanation.source.label}</ExternalLink>
        </p>
        {explanation.note && <p>{explanation.note}</p>}
        <h4>{text.gapHeading}</h4>
        <p>{explanation.gap}</p>
        {explanation.findings.length > 0 && (
          <>
            <h4>{text.findingsHeading}</h4>
            <ul>
              {explanation.findings.map((finding) => (
                <li key={finding}>{finding}</li>
              ))}
            </ul>
          </>
        )}
        {explanation.quote && (
          <blockquote className="dora-explain-quote">
            <p>{explanation.quote.text}</p>
            <ExternalLink href={explanation.quote.href}>{explanation.quote.label}</ExternalLink>
          </blockquote>
        )}
        {explanation.practices.length > 0 && (
          <>
            <h4>{text.practicesHeading}</h4>
            <ul>
              {explanation.practices.map((practice) => (
                <li key={practice.url}>
                  <ExternalLink href={practice.url}>{practice.name}</ExternalLink>
                  {` ${practice.why}`}
                </li>
              ))}
            </ul>
          </>
        )}
        <p className="dora-explain-note">{text.systemNote}</p>
      </div>
    </details>
  );
}

export function DoraTile({ title, definition, value, band, detail, reason, noBandNote, explanation }: DoraTileProps) {
  const measured = value !== null;
  return (
    <article className={`tile dora-tile${measured ? "" : " is-unmeasured"}`}>
      <h3 className="tile-label">{title}</h3>
      {measured ? (
        <>
          <p className="tile-value">{value}</p>
          {band ? <BandLabel band={band} /> : noBandNote && <p className="tile-detail">{noBandNote}</p>}
          {detail && <p className="tile-detail">{detail}</p>}
        </>
      ) : (
        <>
          <p className="tile-value tile-value-muted">{copy.dora.notMeasured}</p>
          {reason && <p className="tile-detail">{reason}</p>}
        </>
      )}
      <p className="tile-definition">{definition}</p>
      {measured && explanation && <Explanation title={title} explanation={explanation} />}
    </article>
  );
}
