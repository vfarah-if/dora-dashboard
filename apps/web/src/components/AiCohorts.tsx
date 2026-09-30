import type { RepoReport } from "@dora-dashboard/core";
import { copy } from "../copy";
import { formatDuration, formatNumber, formatPercent } from "../lib/format";

type Cohort = RepoReport["aiCohorts"]["assisted"];

interface Row {
  label: string;
  value: (cohort: Cohort) => string;
}

const ROWS: Row[] = [
  { label: copy.aiCohorts.prs, value: (c) => formatNumber(c.prs, 0) },
  { label: copy.aiCohorts.medianCycle, value: (c) => formatDuration(c.medianCycleHours) },
  { label: copy.aiCohorts.p75Cycle, value: (c) => formatDuration(c.p75CycleHours) },
  { label: copy.aiCohorts.medianSize, value: (c) => formatNumber(c.medianSize, 0) },
  { label: copy.aiCohorts.reviewed, value: (c) => formatPercent(c.reviewedShare) },
  { label: copy.aiCohorts.reverts, value: (c) => formatPercent(c.revertShare) },
];

/** Assisted against unassisted work, with the rule that decides which is which stated beside it. */
export function AiCohorts({ cohorts }: { cohorts: RepoReport["aiCohorts"] }) {
  return (
    <section aria-labelledby="ai-cohorts-title" className="section card">
      <h2 id="ai-cohorts-title" className="section-title">
        {copy.aiCohorts.title}
      </h2>
      <p className="chart-subtitle">{copy.aiCohorts.lede}</p>
      <div className="table-scroll">
        <table className="data-table">
          <caption className="visually-hidden">{copy.aiCohorts.caption}</caption>
          <thead>
            <tr>
              <th scope="col">{copy.aiCohorts.measure}</th>
              <th scope="col" className="numeric">
                {copy.aiCohorts.assisted}
              </th>
              <th scope="col" className="numeric">
                {copy.aiCohorts.unassisted}
              </th>
            </tr>
          </thead>
          <tbody>
            {ROWS.map((row) => (
              <tr key={row.label}>
                <th scope="row">{row.label}</th>
                <td className="numeric">{row.value(cohorts.assisted)}</td>
                <td className="numeric">{row.value(cohorts.unassisted)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="caveat">{copy.aiCohorts.cycleNote}</p>
      <p className="caveat">{copy.aiCohorts.rule}</p>
      {cohorts.unknown > 0 && (
        <p className="caveat">
          {copy.aiCohorts.unknown(cohorts.unknown)} {copy.aiCohorts.unknownHint}
        </p>
      )}
    </section>
  );
}
