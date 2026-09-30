import type { CodeHealthReport, CodeHealthResponse } from "@dora-dashboard/core";
import { useCodeHealth, type CodeHealthRange } from "../api/hooks";
import { copy } from "../copy";
import { locationLabel, shortSha } from "../lib/codeHealth";
import { checkOf, goodAndImprove, limitingSentence, shareLabel, toolName, verdictSentence } from "../lib/codeVerdict";
import { formatDate, formatDateTime, formatNumber, formatPercent } from "../lib/format";
import { GradeTile } from "./GradeTile";
import { SizeDistributionChart } from "./SizeDistributionChart";
import { StatTile } from "./StatTile";
import { EmptyState, ErrorState, SkeletonGrid } from "./States";

const WARN = 10;
const HIGH = 20;
const yesNo = (value: boolean) => (value ? copy.codeHealth.yes : copy.codeHealth.no);

function Hotspots({ report }: { report: CodeHealthReport }) {
  if (report.hotspots.length === 0) return <p className="chart-empty">{copy.codeHealth.hotspots.empty}</p>;
  return (
    <div className="table-scroll">
      <table className="data-table">
        <caption className="visually-hidden">{copy.codeHealth.hotspots.title}</caption>
        <thead>
          <tr>
            <th scope="col">{copy.codeHealth.hotspots.function}</th>
            <th scope="col">{copy.codeHealth.hotspots.location}</th>
            <th scope="col" className="numeric">
              {copy.codeHealth.hotspots.ccn}
            </th>
            <th scope="col" className="numeric">
              {copy.codeHealth.hotspots.nloc}
            </th>
          </tr>
        </thead>
        <tbody>
          {report.hotspots.map((fn) => (
            <tr key={`${fn.file}:${fn.startLine}:${fn.name}`}>
              <th scope="row" className="mono">
                {fn.name}
              </th>
              <td className="mono">{locationLabel(fn)}</td>
              <td className="numeric">{fn.ccn}</td>
              <td className="numeric">{fn.nloc}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Verdict({ report }: { report: CodeHealthReport }) {
  const c = copy.codeHealth;
  const grade = report.grade;
  if (!grade) {
    return (
      <div className="notice notice-info">
        <p className="notice-title">{c.verdict.missingTitle}</p>
        <p>{c.verdict.missing}</p>
      </div>
    );
  }
  return (
    <GradeTile
      large
      title={c.verdict.title}
      band={grade.overall.band}
      detail={verdictSentence(report) ?? ""}
      definition={c.verdict.definition}
    />
  );
}

function Parts({ report }: { report: CodeHealthReport }) {
  const grade = report.grade;
  if (!grade) return null;
  const c = copy.codeHealth;
  const parts = ["maintainability", "testing", "hygiene"] as const;
  return (
    <section aria-labelledby="grade-parts-title" className="section">
      <h3 id="grade-parts-title" className="chart-title">
        {c.parts.title}
      </h3>
      <div className="grade-grid">
        {parts.map((name) => {
          const limit = limitingSentence(report, name);
          return (
            <GradeTile
              key={name}
              title={c.parts[name]}
              band={grade[name].band}
              detail={limit ? c.parts.limitedBy(limit) : c.parts.nothingLimits}
              definition={c.parts[`${name}Definition`]}
            />
          );
        })}
      </div>
    </section>
  );
}

function Lists({ report }: { report: CodeHealthReport }) {
  const c = copy.codeHealth.lists;
  const { good, improve } = goodAndImprove(report);
  return (
    <div className="findings-grid">
      <section aria-labelledby="good-title" className="card">
        <h3 id="good-title" className="chart-title">
          {c.goodTitle}
        </h3>
        {good.length === 0 ? (
          <p className="chart-empty">{c.goodEmpty}</p>
        ) : (
          <ul className="findings-list findings-good">
            {good.map((f) => (
              <li key={f.check}>{f.text}</li>
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="improve-title" className="card">
        <h3 id="improve-title" className="chart-title">
          {c.improveTitle}
        </h3>
        <p className="chart-subtitle">{c.improveHint}</p>
        {improve.length === 0 ? (
          <p className="chart-empty">{c.improveEmpty}</p>
        ) : (
          <ol className="findings-list findings-improve">
            {improve.map((f) => (
              <li key={f.check}>{f.text}</li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

function Tiles({ report }: { report: CodeHealthReport }) {
  const d = copy.codeHealth.detail;
  const most = report.mostComplex;
  return (
    <div className="tile-grid tile-grid-flow">
      <StatTile
        label={d.above(WARN)}
        value={d.aboveValue(formatNumber(report.countAboveWarn, 0), shareLabel(report.shareAboveWarn))}
        hint={d.aboveHint(WARN)}
      />
      <StatTile
        label={d.above(HIGH)}
        value={d.aboveValue(formatNumber(report.countAboveHigh, 0), shareLabel(report.shareAboveHigh))}
        hint={d.aboveHint(HIGH)}
      />
      <StatTile
        label={d.mostComplex}
        value={most ? d.mostComplexValue(formatNumber(most.ccn, 0)) : d.mostComplexNone}
        hint={most ? d.mostComplexHint(most.name, locationLabel(most)) : undefined}
      />
      <StatTile label={d.nloc} value={formatNumber(report.nloc, 0)} hint={d.nlocHint} />
      <StatTile
        label={d.functions}
        value={formatNumber(report.functions, 0)}
        hint={d.functionsHint(formatNumber(report.tests.functions, 0))}
      />
    </div>
  );
}

function TestingPanel({ report }: { report: CodeHealthReport }) {
  const c = copy.codeHealth.testing;
  const t = report.testing;
  const prs = t.prsWithTests
    ? c.prsValue(formatPercent(t.prsWithTests.share), t.prsWithTests.withTests, t.prsWithTests.total)
    : c.prsNeedsCrawl;
  return (
    <section aria-labelledby="testing-title" className="card">
      <h3 id="testing-title" className="chart-title">
        {c.title}
      </h3>
      <p className="chart-subtitle">{c.subtitle}</p>
      <dl className="fact-list">
        <dt>{c.ratio}</dt>
        <dd>{c.ratioValue(t.testRatio.toFixed(2))}</dd>
        <dt>{c.prs}</dt>
        <dd>{prs}</dd>
        <dt>{c.floor}</dt>
        <dd>
          {t.ciRunsTests === null
            ? copy.codeHealth.unknown
            : t.coverageFloor === null
              ? c.floorNone
              : checkOf(report, "coverageFloor")?.met
                ? c.floorValue(t.coverageFloor)
                : c.floorBelow(t.coverageFloor)}
        </dd>
        <dt>{c.ci}</dt>
        <dd>{t.ciRunsTests === null ? copy.codeHealth.unknown : yesNo(t.ciRunsTests)}</dd>
      </dl>
    </section>
  );
}

function HygienePanel({ report }: { report: CodeHealthReport }) {
  const c = copy.codeHealth.hygiene;
  const h = report.hygiene;
  const weak = report.tooling?.weakFormatters ?? [];
  const rows = h
    ? [
        ...h.linters.map((tool) => ({ tool, kind: c.linter, enforced: yesNo(h.ciLinters.includes(tool)) })),
        ...h.formatters.map((tool) => ({ tool, kind: c.formatter, enforced: yesNo(h.ciFormatChecks.includes(tool)) })),
        ...weak.map((tool) => ({ tool, kind: c.weak, enforced: c.notApplicable })),
      ]
    : [];
  return (
    <section aria-labelledby="hygiene-title" className="card">
      <h3 id="hygiene-title" className="chart-title">
        {c.title}
      </h3>
      <p className="chart-subtitle">{c.subtitle}</p>
      {!h ? (
        <p className="chart-empty">{copy.codeHealth.testing.unavailable}</p>
      ) : rows.length === 0 ? (
        <p className="chart-empty">{c.none}</p>
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <caption className="visually-hidden">{c.title}</caption>
            <thead>
              <tr>
                <th scope="col">{c.tool}</th>
                <th scope="col">{c.kind}</th>
                <th scope="col">{c.configured}</th>
                <th scope="col">{c.enforced}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${row.kind}-${row.tool}`}>
                  <th scope="row">{toolName(row.tool)}</th>
                  <td>{row.kind}</td>
                  <td>{copy.codeHealth.yes}</td>
                  <td>{row.enforced}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {weak.length > 0 && <p className="chart-subtitle">{c.weakNote}</p>}
    </section>
  );
}

/** How to install lizard on each platform, shown only when the API reports that it cannot find it. */
function InstallLizard() {
  const c = copy.codeHealth.install;
  return (
    <section className="install-help card" aria-labelledby="install-lizard-title">
      <h3 id="install-lizard-title" className="install-help-title">
        {c.title}
      </h3>
      <p>{c.intro}</p>
      <dl className="install-help-options">
        {c.options.map((option) => (
          <div key={option.label} className="install-help-option">
            <dt>{option.label}</dt>
            <dd>
              <pre className="install-help-commands">
                <code>{option.commands.join("\n")}</code>
              </pre>
            </dd>
          </div>
        ))}
      </dl>
      <p>{c.after}</p>
    </section>
  );
}

/** Warns that the figures come from an earlier analysis because the latest one failed. */
function StaleNotice({ report }: { report: CodeHealthReport }) {
  const c = copy.codeHealth;
  if (!report.lastError) return null;
  return (
    <aside className="notice notice-warning">
      <p className="notice-title">{c.staleTitle}</p>
      <p>{c.stale(formatDate(report.analysedAt), formatDate(report.lastError.analysedAt), report.lastError.message)}</p>
    </aside>
  );
}

function HotspotsCard({ report }: { report: CodeHealthReport }) {
  const c = copy.codeHealth;
  return (
    <section aria-labelledby="hotspots-title" className="card">
      <h3 id="hotspots-title" className="chart-title">
        {c.hotspots.title}
      </h3>
      <p className="chart-subtitle">{c.hotspots.subtitle}</p>
      <Hotspots report={report} />
    </section>
  );
}

function CodeHealthReportView({ report }: { report: CodeHealthReport }) {
  const c = copy.codeHealth;
  return (
    <>
      <p className="chart-subtitle">{c.analysedAt(shortSha(report.commitSha), formatDateTime(report.analysedAt))}</p>
      <StaleNotice report={report} />
      {report.lastError?.reason === "analyser-missing" && <InstallLizard />}

      <Verdict report={report} />
      <Lists report={report} />
      <Parts report={report} />

      <h3 className="section-title">{c.detail.title}</h3>
      <Tiles report={report} />

      <SizeDistributionChart report={report} />

      <div className="findings-grid">
        <TestingPanel report={report} />
        <HygienePanel report={report} />
      </div>

      <HotspotsCard report={report} />

      <aside className="notice notice-info">
        <p className="notice-title">{c.explainerTitle}</p>
        <p>{c.explainer}</p>
      </aside>
    </>
  );
}

type FailedAnalysis = Extract<CodeHealthResponse, { status: "error" }>;

function AnalysisFailed({ data }: { data: FailedAnalysis }) {
  const c = copy.codeHealth;
  return (
    <>
      <div className="notice notice-error" role="alert">
        <p className="notice-title">{c.error.title}</p>
        <p>{data.message}</p>
        <p>{c.error.when(formatDateTime(data.analysedAt))}</p>
      </div>
      {data.reason === "analyser-missing" && <InstallLizard />}
    </>
  );
}

/** What the API said about the analysis once it answered: nothing yet, a failure, or a report. */
function AnalysisOutcome({ data }: { data: CodeHealthResponse }) {
  const c = copy.codeHealth;
  if (data.status === "error") return <AnalysisFailed data={data} />;
  if (data.status === "ok") return <CodeHealthReportView report={data} />;
  return (
    <EmptyState title={c.none.title}>
      <p>{c.none.body}</p>
    </EmptyState>
  );
}

/** The code health section of the repository page, covering loading, empty, error and ok states. */
export function CodeHealthSection({ repoId, range }: { repoId: number; range?: CodeHealthRange }) {
  const health = useCodeHealth(repoId, range);
  const c = copy.codeHealth;
  return (
    <section aria-labelledby="code-health-title" className="section">
      <h2 id="code-health-title" className="section-title">
        {c.title}
      </h2>
      <p className="section-lede">{c.lede}</p>
      {health.isPending && <SkeletonGrid count={4} height={120} label={c.loading} />}
      {health.isError && <ErrorState error={health.error} onRetry={() => void health.refetch()} />}
      {health.data && <AnalysisOutcome data={health.data} />}
    </section>
  );
}
