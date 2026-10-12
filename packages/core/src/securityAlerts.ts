import {
  LIKELY_EXPLOITED_EPSS,
  type AlertSource,
  type SecurityAlert,
  type Severity,
  type SourceError,
  type SourceRead,
  type SourceState,
} from "./securityTypes.js";

/**
 * How severities rank, lowest number worst. An unrated alert is graded as medium (`FIX_WITHIN_DAYS`), so it ranks just
 * below a real medium and above low, which is where the grade already treats it. `SEVERITIES` keeps its own order for
 * display; this is the order for deciding which alert or package is worse.
 */
export const SEVERITY_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, unknown: 3, low: 4 };

/** The worse of two severities by `SEVERITY_RANK`; the first when they rank alike. */
export const worseSeverity = (a: Severity, b: Severity): Severity => (SEVERITY_RANK[a] <= SEVERITY_RANK[b] ? a : b);

const RULE_SEVERITY: Record<"none" | "note" | "warning" | "error", Severity> = {
  error: "high",
  warning: "medium",
  note: "low",
  none: "low",
};

/**
 * An alert's severity. For code scanning and secret scanning it is worked out when a report is built, so a change to
 * that mapping needs no crawl (as issue kinds are, ADR 0028). Null for a code scanning alert that is about quality
 * rather than security, which is never graded.
 *
 * - Dependabot and OSV: the severity as published, mapped once when the alert is read and stored with it, so a change
 *   to that mapping applies from the next crawl that reads the alert.
 * - Code scanning: GitHub's security severity when there is one; otherwise, for a rule tagged `security`, error is high,
 *   warning medium and note low.
 * - Secret scanning: a secret that still works, may still work, or has leaked publicly is critical; one GitHub says no
 *   longer works is low.
 */
export function severityOf(alert: SecurityAlert): Severity | null {
  switch (alert.source) {
    case "dependabot":
    case "osv":
      return alert.severity;
    case "code_scanning": {
      const { securitySeverity, securityTagged, ruleSeverity } = alert.code;
      if (securitySeverity) return securitySeverity;
      if (!securityTagged) return null;
      return RULE_SEVERITY[ruleSeverity ?? "none"];
    }
    case "secret_scanning": {
      const { validity, publiclyLeaked } = alert.exposure;
      return publiclyLeaked || validity !== "inactive" ? "critical" : "low";
    }
  }
}

/**
 * The read whose alerts a source's state stands on: this attempt's when it succeeded, or the last good one an `error`
 * state carries. Null for every other state, including `no_access`, whose stored alerts are kept but not used.
 */
export function lastGoodRead(state: SourceState): SourceRead | null {
  if (state.status === "ok") return { readAt: state.readAt, truncated: state.truncated, skipped: state.skipped };
  return state.status === "error" ? state.lastGood : null;
}

/** A source's alerts can be used when it was read, or when its last read failed but an earlier one succeeded. */
export function isUsable(state: SourceState): boolean {
  return lastGoodRead(state) !== null;
}

/**
 * The state after an attempt failed. The last good read is kept only from an `ok` state or from an `error` state that
 * still had one, so a failure after `no_access`, `off` or `not_used` cannot bring back alerts that were not in use.
 */
export function failedSource(previous: SourceState, error: string, attemptedAt: string): SourceError {
  return { status: "error", error, attemptedAt, lastGood: lastGoodRead(previous) };
}

/**
 * Whether each source's alerts count. Dependency alerts come from Dependabot when it is usable and otherwise from OSV,
 * so the two are never counted together; code scanning and secret scanning count when usable.
 */
export function usedSources(sources: Record<AlertSource, SourceState>): Record<AlertSource, boolean> {
  const dependabot = isUsable(sources.dependabot);
  return {
    dependabot,
    code_scanning: isUsable(sources.code_scanning),
    secret_scanning: isUsable(sources.secret_scanning),
    osv: !dependabot && isUsable(sources.osv),
  };
}

/** The exploit prediction for a dependency alert, or null for any other kind or when none is published. */
export function epssOf(alert: SecurityAlert): number | null {
  return alert.source === "dependabot" || alert.source === "osv" ? (alert.dependency.epss?.percentage ?? null) : null;
}

/** True when the exploit prediction says the alert is likely to be exploited soon. */
export function isLikelyExploited(alert: SecurityAlert): boolean {
  const epss = epssOf(alert);
  return epss !== null && epss >= LIKELY_EXPLOITED_EPSS;
}

/** `CWE-79` for `cwe-079`, `CWE-079` or `CWE-79`. Text that is not a weakness id is returned unchanged. */
export function normaliseCwe(id: string): string {
  // The number starts at a digit other than 0, or is a lone 0, so a leading zero can only be read one way. Read by
  // either `0*` or `\d+`, a long run of zeros took time in the square of its length.
  const match = /^cwe-0*([1-9]\d*|0)$/i.exec(id.trim());
  return match ? `CWE-${match[1]}` : id;
}

/** The weakness ids an alert names, such as "CWE-79", normalised so stored zero padded ids read the same. Secrets name none. */
export function cwesOf(alert: SecurityAlert): string[] {
  const raw =
    alert.source === "code_scanning" ? alert.code.cwes : alert.source === "secret_scanning" ? [] : alert.dependency.cwes;
  return [...new Set(raw.map(normaliseCwe))];
}
