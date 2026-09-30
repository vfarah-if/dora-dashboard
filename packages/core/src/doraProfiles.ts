// ADR 0016

/** Thresholds for the elite, high and medium bands, in that order; anything beyond medium is low. */
export type BandThresholds = readonly [elite: number, high: number, medium: number];

/**
 * A named, cited set of DORA band thresholds, so every grade can say which standard produced it.
 * Deployment frequency is deploys per week and is compared with `>=`; change failure is a rate compared
 * with `<=`; the two durations are hours compared with a strict `<`.
 */
export interface DoraProfile {
  id: string;
  name: string;
  source: { title: string; year: number; url: string };
  deployFrequency: BandThresholds;
  leadTimeHours: BandThresholds;
  changeFailure: BandThresholds;
  restoreHours: BandThresholds;
}

export const DORA_PROFILES: readonly DoraProfile[] = [
  {
    id: "dora-2023",
    name: "DORA 2023",
    source: {
      title: "2023 Accelerate State of DevOps Report",
      year: 2023,
      url: "https://dora.dev/research/2023/dora-report/2023-dora-accelerate-state-of-devops-report.pdf",
    },
    // On demand (daily or more), between daily and weekly, between weekly and every four weeks.
    deployFrequency: [7, 1, 0.25],
    // Under a day, under a week, under 30 days.
    leadTimeHours: [24, 168, 720],
    changeFailure: [0.05, 0.1, 0.15],
    // Under an hour, under a day, under a week.
    restoreHours: [1, 24, 168],
  },
];

export const DEFAULT_DORA_PROFILE = "dora-2023";

export const DORA_PROFILE_IDS: readonly string[] = DORA_PROFILES.map((p) => p.id);

/** The profile with this id. Throws for an unknown id, so a typo never grades silently against a default. */
export function doraProfile(id: string): DoraProfile {
  const found = DORA_PROFILES.find((p) => p.id === id);
  if (!found) throw new Error(`Unknown DORA profile "${id}". Known profiles: ${DORA_PROFILE_IDS.join(", ")}.`);
  return found;
}
