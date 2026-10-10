import type { CodeDetailReport, CoverageShare } from "@dora-dashboard/core";
import { copy } from "../copy";
import { areaLabel, rangesLabel } from "../lib/codeDetail";
import { shortSha } from "../lib/codeHealth";
import { formatDate, formatDateTime, formatNumber, formatPercent } from "../lib/format";
import { FunctionTable } from "./FunctionTable";
import { PathText } from "./PathText";
import { ShowAllList } from "./ShowAllList";
import { StatTile } from "./StatTile";
import { EmptyState } from "./States";

type OkCoverage = Extract<CodeDetailReport["coverage"], { status: "ok" }>;

function Tile({
  label,
  share,
  hint,
}: {
  label: string;
  share: CoverageShare | null;
  hint: (covered: string, total: string) => string;
}) {
  const t = copy.codeAnalysis.coverage.tiles;
  return (
    <StatTile
      label={label}
      value={share ? formatPercent(share.share) : t.notReported}
      hint={share ? hint(formatNumber(share.covered, 0), formatNumber(share.total, 0)) : t.notReportedHint}
    />
  );
}

function CappedNote({ shown, total, text }: { shown: number; total: number; text: (shown: number, total: number) => string }) {
  return total > shown ? <p className="chart-subtitle">{text(shown, total)}</p> : null;
}

/** Line figures follow the lines of the commit the coverage was measured on, so say so beside each table that relies on them. */
export function OtherCommitNote({ view }: { view: Pick<OkCoverage, "otherCommit"> }) {
  return view.otherCommit ? (
    <p className="chart-subtitle" role="note">
      {copy.codeAnalysis.coverage.lineNote}
    </p>
  ) : null;
}

function LeastCovered({ view }: { view: OkCoverage }) {
  const c = copy.codeAnalysis.coverage.least;
  const files = view.leastCovered.items;
  return (
    <section aria-labelledby="least-covered-title" className="card">
      <h3 id="least-covered-title" className="chart-title">
        {c.title}
      </h3>
      <p className="chart-subtitle">{c.subtitle}</p>
      <OtherCommitNote view={view} />
      {files.length === 0 ? (
        <p className="chart-empty">{c.empty}</p>
      ) : (
        <>
          <ShowAllList total={files.length}>
            {(limit) => (
              <div className="table-scroll">
                <table className="data-table coverage-table">
                  <caption className="visually-hidden">{c.title}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{c.file}</th>
                      <th scope="col" className="numeric">
                        {c.covered}
                      </th>
                      <th scope="col">{c.notRun}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {files.slice(0, limit).map((file) => (
                      <tr key={file.path}>
                        <th scope="row" className="mono wrap-anywhere">
                          <PathText text={file.path} />
                        </th>
                        <td className="numeric">{c.coveredValue(file.lines.covered, file.lines.total)}</td>
                        <td className="mono wrap-anywhere">
                          {view.lineDetail ? rangesLabel(file.uncovered) : copy.common.notAvailable}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </ShowAllList>
          <CappedNote shown={files.length} total={view.leastCovered.total} text={c.capped} />
        </>
      )}
    </section>
  );
}

function NotInReport({ view }: { view: OkCoverage }) {
  const c = copy.codeAnalysis.coverage.notInReport;
  const files = view.notInReport.items;
  return (
    <section aria-labelledby="not-in-report-title" className="card">
      <h3 id="not-in-report-title" className="chart-title">
        {c.title}
      </h3>
      <p className="chart-subtitle">{c.subtitle}</p>
      {files.length === 0 ? (
        <p className="chart-empty">{c.empty}</p>
      ) : (
        <>
          <ShowAllList total={files.length}>
            {(limit) => (
              <div className="table-scroll">
                <table className="data-table coverage-table">
                  <caption className="visually-hidden">{c.title}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{c.file}</th>
                      <th scope="col" className="numeric">
                        {c.functions}
                      </th>
                      <th scope="col" className="numeric">
                        {c.nloc}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {files.slice(0, limit).map((file) => (
                      <tr key={file.path}>
                        <th scope="row" className="mono wrap-anywhere">
                          <PathText text={file.path} />
                        </th>
                        <td className="numeric">{formatNumber(file.functions, 0)}</td>
                        <td className="numeric">{formatNumber(file.nloc, 0)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </ShowAllList>
          <CappedNote shown={files.length} total={view.notInReport.total} text={c.capped} />
        </>
      )}
    </section>
  );
}

function Untested({ view, warn }: { view: OkCoverage; warn: number }) {
  const c = copy.codeAnalysis.coverage.untested;
  const rows = view.untestedComplex.items;
  return (
    <section aria-labelledby="untested-title" className="card">
      <h3 id="untested-title" className="chart-title">
        {c.title}
      </h3>
      <p className="chart-subtitle">{c.subtitle(warn)}</p>
      <OtherCommitNote view={view} />
      <ShowAllList total={rows.length}>
        {(limit) => (
          <FunctionTable rows={rows.slice(0, limit)} caption={c.title} areaLabel={areaLabel} showAdvice={false} empty={c.empty} />
        )}
      </ShowAllList>
      <CappedNote shown={rows.length} total={view.untestedComplex.total} text={c.capped} />
    </section>
  );
}

function Notices({ view, commitSha }: { view: OkCoverage; commitSha: string }) {
  const c = copy.codeAnalysis.coverage;
  return (
    <>
      {view.lastError && (
        <aside className="notice notice-warning">
          <p className="notice-title">{c.lastError.title}</p>
          <p>{c.lastError.body(view.lastError.message, formatDate(view.lastError.fetchedAt))}</p>
        </aside>
      )}
      {view.otherCommit && (
        <aside className="notice notice-warning">
          <p className="notice-title">{c.otherCommit.title}</p>
          <p>{c.otherCommit.body(view.source.commitSha ? shortSha(view.source.commitSha) : null, shortSha(commitSha))}</p>
        </aside>
      )}
    </>
  );
}

function CoverageFigures({ view, detail }: { view: OkCoverage; detail: CodeDetailReport }) {
  const c = copy.codeAnalysis.coverage;
  const run = view.source.runId === null ? "" : c.sourceRun(view.source.runId);
  return (
    <>
      <Notices view={view} commitSha={detail.commitSha} />
      <div className="tile-grid tile-grid-flow">
        <Tile label={c.tiles.lines} share={view.lines} hint={c.tiles.linesHint} />
        <Tile label={c.tiles.branches} share={view.branches} hint={c.tiles.branchesHint} />
        <Tile label={c.tiles.functions} share={view.functions} hint={c.tiles.functionsHint} />
      </div>
      <p className="chart-subtitle">
        {c.source(
          view.source.artefacts.join(", "),
          run,
          formatDateTime(view.source.fetchedAt),
          view.source.formats.join(", "),
          view.source.createdAt ? formatDateTime(view.source.createdAt) : null,
        )}
      </p>
      <p className="chart-subtitle">{c.files(view.files.matched, view.files.inReport, view.files.unmatched)}</p>
      {!view.lineDetail && <p className="chart-subtitle">{c.totalsOnly}</p>}
      <LeastCovered view={view} />
      <NotInReport view={view} />
      <Untested view={view} warn={detail.thresholds.warn} />
    </>
  );
}

/** What was measured when the tests ran, and what was not: tiles, the least covered files, files missing from the report and untested complex functions. */
export function CoveragePanel({ detail }: { detail: CodeDetailReport }) {
  const c = copy.codeAnalysis.coverage;
  const view = detail.coverage;
  return (
    <section aria-labelledby="coverage-title" className="section">
      <h2 id="coverage-title" className="section-title">
        {c.title}
      </h2>
      <p className="section-lede">{c.lede}</p>
      {view.status === "none" && (
        <EmptyState title={c.empty.title}>
          <p>{c.empty.intro}</p>
          <ul className="empty-points">
            {c.empty.points.map((point) => (
              <li key={point}>{point}</li>
            ))}
          </ul>
        </EmptyState>
      )}
      {view.status === "error" && (
        <div className="notice notice-error" role="alert">
          <p className="notice-title">{c.error.title}</p>
          <p>{c.error.body(view.message, formatDate(view.fetchedAt))}</p>
        </div>
      )}
      {view.status === "ok" && <CoverageFigures view={view} detail={detail} />}
    </section>
  );
}
