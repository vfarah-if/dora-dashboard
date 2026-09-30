import type { RepoQueueSummary } from "@dora-dashboard/core";
import { copy } from "../copy";
import { bandSegments, BAND_ORDER, lanesLine, waitingCount } from "../lib/reviewQueue";
import { DataTable } from "./ChartCard";

const text = copy.reviewQueue;

export function BandLegend() {
  return (
    <div className="band-legend">
      <ul aria-label={text.repos.legendLabel} className="band-legend-list">
        {BAND_ORDER.map((band) => (
          <li key={band}>
            <span className={`band-swatch band-seg-${band}`} aria-hidden="true" />
            {text.bands[band]}
          </li>
        ))}
      </ul>
      <p className="chart-subtitle">{text.repos.weekendNote}</p>
    </div>
  );
}

/** One repository's waiting pull requests as a stacked bar by band, with the same counts in a table. */
export function RepoQueueCard({ summary }: { summary: RepoQueueSummary }) {
  const segments = bandSegments(summary);
  const waiting = waitingCount(summary);
  const lanes = lanesLine(summary);
  return (
    <li className="card repo-queue-card">
      <h4 className="chart-title">{summary.repo}</h4>
      <p className="chart-subtitle">{text.repos.cardSubtitle(summary.open)}</p>
      {waiting === 0 ? (
        <p className="chart-subtitle">{text.repos.noWaiting}</p>
      ) : (
        <>
          <div className="band-bar" role="img" aria-label={text.repos.barLabel(summary.repo)}>
            {segments.map(({ band, count }) => (
              <span
                key={band}
                className={`band-seg band-seg-${band}`}
                style={{ flexGrow: count }}
                title={text.repos.segmentTitle(text.bands[band], count)}
              />
            ))}
          </div>
          <ul className="band-counts">
            {segments.map(({ band, count }) => (
              <li key={band}>{text.repos.segmentTitle(text.bands[band], count)}</li>
            ))}
          </ul>
        </>
      )}
      {lanes && <p className="chart-subtitle">{text.repos.lanesLine(lanes)}</p>}
      <details className="table-disclosure">
        <summary>{copy.common.viewAsTable}</summary>
        <DataTable
          caption={summary.repo}
          columns={[text.repos.tableBand, text.repos.tableCount]}
          rows={BAND_ORDER.map((band) => [text.bands[band], summary.bands[band]])}
        />
      </details>
    </li>
  );
}
