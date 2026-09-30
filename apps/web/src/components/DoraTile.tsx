import type { Band } from "@dora-dashboard/core";
import { copy } from "../copy";
import { BandLabel } from "./BandLabel";

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
}

export function DoraTile({ title, definition, value, band, detail, reason, noBandNote }: DoraTileProps) {
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
    </article>
  );
}
