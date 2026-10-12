import type { ReviewExemptionDefaults, ReviewExemptionRules } from "@dora-dashboard/core";
import { formatLabelList, parseLabelList } from "./issues";

/** The text of the two boxes in the reviewed elsewhere editor. */
export interface ExemptionInputs {
  titleWords: string;
  labels: string;
}

/** The boxes for the rules in force: the repository's override, or the defaults when it has none. */
export function inputsFor(rules: ReviewExemptionRules | null, defaults: ReviewExemptionRules | undefined): ExemptionInputs {
  const used = rules ?? defaults;
  return { titleWords: formatLabelList(used?.titleWords), labels: formatLabelList(used?.labels) };
}

/** The rules the boxes stand for. A box left empty leaves nothing out of that kind, so both lists are always sent. */
export function rulesFromInputs(inputs: ExemptionInputs): ReviewExemptionRules {
  return { titleWords: parseLabelList(inputs.titleWords), labels: parseLabelList(inputs.labels) };
}

const hasControlCharacter = (entry: string): boolean =>
  [...entry].some((char) => {
    const code = char.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });

/** What is wrong with one box's text, if anything, by the limits and rules the API enforces. */
export function exemptionProblem(
  text: string,
  maxEntries: number,
  limits: ReviewExemptionDefaults["limits"],
): "tooMany" | "tooLong" | "control" | null {
  const entries = parseLabelList(text);
  if (entries.length > maxEntries) return "tooMany";
  if (entries.some((entry) => entry.length > limits.length)) return "tooLong";
  if (entries.some(hasControlCharacter)) return "control";
  return null;
}
