import type { Hotspot } from "@dora-dashboard/core";
import { copy } from "../copy";

export const PARTLY_MEASURED_SHOWN = 10;

/** The short advice for a hotspot, chosen by how it earns its score. */
export function adviceFor(shape: Hotspot["shape"]): string {
  return shape === null ? copy.codeHealth.hotspots.adviceFor.within : copy.codeHealth.hotspots.adviceFor[shape];
}

/** The first files to list, and how many more there are. */
export function splitPartlyMeasured(files: readonly string[]): { shown: string[]; rest: number } {
  return { shown: files.slice(0, PARTLY_MEASURED_SHOWN), rest: Math.max(0, files.length - PARTLY_MEASURED_SHOWN) };
}
