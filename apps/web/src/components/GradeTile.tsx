import type { Band } from "@dora-dashboard/core";
import { BandLabel } from "./BandLabel";

export interface GradeTileProps {
  title: string;
  band: Band;
  /** The sentence naming the check that limited the band. */
  detail: string;
  definition?: string;
  /** The overall verdict is drawn larger than a part. */
  large?: boolean;
}

/** A band tile in the DORA style. The band is always printed as text beside its icon. */
export function GradeTile({ title, band, detail, definition, large }: GradeTileProps) {
  return (
    <article className={`tile dora-tile grade-tile${large ? " grade-tile-large" : ""}`}>
      <h3 className="tile-label">{title}</h3>
      <BandLabel band={band} />
      <p className="tile-detail">{detail}</p>
      {definition && <p className="tile-definition">{definition}</p>}
    </article>
  );
}
