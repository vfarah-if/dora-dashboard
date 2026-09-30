import type { AuthorChoice } from "@dora-dashboard/core";

/** The excluded logins after ticking (include) or unticking one author. Other exclusions are kept. */
export function toggleAuthor(excluded: readonly string[], login: string, include: boolean): string[] {
  const rest = excluded.filter((name) => name !== login);
  return include ? rest : [...rest, login];
}

/** Every author on offer left out, keeping exclusions of authors who are not in this range. */
export function excludeEveryone(excluded: readonly string[], choices: readonly AuthorChoice[]): string[] {
  return [...new Set([...excluded, ...choices.map((choice) => choice.author)])];
}

/** The authors on offer who are currently left out, in the order the menu lists them. */
export function excludedInRange(choices: readonly AuthorChoice[], excluded: readonly string[]): string[] {
  return choices.filter((choice) => excluded.includes(choice.author)).map((choice) => choice.author);
}

/** True when authors are on offer and every one of them is left out, so the report would show nobody. */
export function everyoneLeftOut(choices: readonly AuthorChoice[], leftOut: readonly string[]): boolean {
  return choices.length > 0 && leftOut.length === choices.length;
}
