const DOTTED = /^v?(\d+(?:\.\d+)*)$/;

/**
 * Compares two dotted numeric versions such as `1.2.10` and `1.2.9`, with an optional leading `v`; a missing part
 * counts as zero, so `1.2` equals `1.2.0`. Answers null for anything else, such as a pre-release or a component too large to compare exactly, because ordering those
 * is ecosystem specific and a wrong answer would advise the wrong upgrade.
 */
export function compareVersions(a: string, b: string): number | null {
  const left = DOTTED.exec(a.trim());
  const right = DOTTED.exec(b.trim());
  if (!left || !right) return null;
  const x = left[1]!.split(".").map(Number);
  const y = right[1]!.split(".").map(Number);
  // A component beyond 2^53 loses precision and can become Infinity, so the difference could be NaN.
  if (![...x, ...y].every(Number.isSafeInteger)) return null;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const difference = (x[i] ?? 0) - (y[i] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

/** The highest of the versions when every one compares with the others, else null. Null for an empty list. */
export function highestVersion(versions: readonly string[]): string | null {
  let highest: string | null = null;
  for (const version of versions) {
    if (highest === null) {
      if (compareVersions(version, version) === null) return null;
      highest = version;
      continue;
    }
    const order = compareVersions(version, highest);
    if (order === null) return null;
    if (order > 0) highest = version;
  }
  return highest;
}
