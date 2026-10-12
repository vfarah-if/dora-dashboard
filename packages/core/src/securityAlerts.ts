import { LIKELY_EXPLOITED_EPSS, type SecurityAlert, type Severity, type SourceState } from "./securityTypes.js";

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
 * An alert's severity, worked out when a report is built so a change to the mapping needs no crawl (as issue kinds are,
 * ADR 0028). Null for a code scanning alert that is about quality rather than security, which is never graded.
 *
 * - Dependabot and OSV: the severity as published.
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

/** A source's alerts can be used when it was read, or when its last read failed but an earlier one succeeded. */
export function isUsable(state: SourceState): boolean {
  return state.status === "ok" || (state.status === "error" && state.readAt !== null);
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

/** The weakness ids an alert names, such as "CWE-79". Secrets name none. */
export function cwesOf(alert: SecurityAlert): string[] {
  if (alert.source === "code_scanning") return alert.code.cwes;
  if (alert.source === "secret_scanning") return [];
  return alert.dependency.cwes;
}
