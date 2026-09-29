import type { Band } from "@dora-dashboard/core";
import { copy } from "../copy";
import { BandIcon } from "./BandIcon";

export function BandLabel({ band }: { band: Band }) {
  return (
    <span className={`band-label band-${band}`}>
      <BandIcon band={band} />
      <span>{copy.dora.band[band]}</span>
    </span>
  );
}
