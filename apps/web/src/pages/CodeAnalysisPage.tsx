import { Link, useLocation, useNavigate, useParams } from "react-router";
import type { CodeDetailReport, CodeDetailResponse } from "@dora-dashboard/core";
import { isRecordId, useCodeDetail, useCodeHealth, useRepos } from "../api/hooks";
import { copy } from "../copy";
import { AreasCard } from "../components/AreasCard";
import { BandLabel } from "../components/BandLabel";
import { FigureTiles, StartCard } from "../components/CodeFigureParts";
import { CoveragePanel, OtherCommitNote } from "../components/CoveragePanel";
import { DownloadReportButton } from "../components/DownloadReportButton";
import { FunctionTable } from "../components/FunctionTable";
import { ShowAllList } from "../components/ShowAllList";
import { SizeDistributionChart } from "../components/SizeDistributionChart";
import { EmptyState, ErrorState, SkeletonGrid } from "../components/States";
import { StickyPanel } from "../components/StickyPanel";
import { areaLabel, maintainabilityLines, searchWithArea } from "../lib/codeDetail";
import { shortSha } from "../lib/codeHealth";
import { formatDate, formatDateTime } from "../lib/format";
import { repoName } from "../lib/series";
import { useRangeParams, useTextParam } from "../lib/urlState";

const c = copy.codeAnalysis;

function Notices({ detail, clearArea }: { detail: CodeDetailReport; clearArea: () => void }) {
  return (
    <>
      {detail.lastError && (
        <aside className="notice notice-warning">
          <p className="notice-title">{c.staleTitle}</p>
          <p>{c.stale(formatDate(detail.analysedAt), formatDate(detail.lastError.analysedAt), detail.lastError.message)}</p>
        </aside>
      )}
      {detail.mode === "unknown" && (
        <aside className="notice notice-info">
          <p className="notice-title">{c.unknownMode.title}</p>
          <p>{c.unknownMode.body}</p>
        </aside>
      )}
      {detail.missingArea !== undefined && (
        <aside className="notice notice-warning">
          <p className="notice-title">{c.missingArea.title}</p>
          <p>{c.missingArea.body(detail.missingArea)}</p>
          <button type="button" className="button button-secondary" onClick={clearArea}>
            {c.missingArea.clear}
          </button>
        </aside>
      )}
    </>
  );
}

function ScopeChecks({ detail }: { detail: CodeDetailReport }) {
  const k = c.scope.checks;
  const lines = maintainabilityLines(detail.scope);
  return (
    <section aria-labelledby="scope-checks-title" className="card">
      <h3 id="scope-checks-title" className="chart-title">
        {k.title}
      </h3>
      <p className="chart-subtitle">{k.subtitle}</p>
      <p className="band-line">
        <span>{k.bandLabel}</span>{" "}
        {detail.scope.maintainabilityBand ? <BandLabel band={detail.scope.maintainabilityBand} /> : <span>{k.noBand}</span>}
      </p>
      <p className="chart-subtitle">{k.bandNote}</p>
      <ul className="findings-list check-list">
        {lines.map((line) => (
          <li key={line.check}>
            {line.text} <BandLabel band={line.band} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function ScopeFunctions({ detail }: { detail: CodeDetailReport }) {
  const f = c.functions;
  const rows = detail.functions.items;
  return (
    <section aria-labelledby="scope-functions-title" className="card screen-only">
      <h3 id="scope-functions-title" className="chart-title">
        {f.title}
      </h3>
      <p className="chart-subtitle">{f.subtitle}</p>
      {detail.coverage.status === "ok" && <OtherCommitNote view={detail.coverage} />}
      <ShowAllList total={rows.length}>
        {(limit) => (
          <FunctionTable
            rows={rows.slice(0, limit)}
            caption={f.title}
            areaLabel={areaLabel}
            showCoverage={detail.coverage.status === "ok"}
            showAdvice={false}
          />
        )}
      </ShowAllList>
      {detail.functions.total > rows.length && <p className="chart-subtitle">{f.capped(rows.length, detail.functions.total)}</p>}
    </section>
  );
}

function SelectedScope({ detail }: { detail: CodeDetailReport }) {
  const s = c.scope;
  const partly = detail.scope.partlyMeasured;
  return (
    <section aria-labelledby="scope-title" className="section">
      <h2 id="scope-title" className="section-title">
        {detail.area === null ? s.titleWhole : s.titleArea(areaLabel(detail.area))}
      </h2>
      <p className="section-lede">{s.subtitle}</p>
      {detail.scope.functions === 0 ? (
        <p className="chart-empty">{s.empty}</p>
      ) : (
        <>
          <FigureTiles figures={detail.scope} thresholds={detail.thresholds} />
          <ScopeChecks detail={detail} />
          <SizeDistributionChart figures={detail.scope} />
          <StartCard figures={detail.scope} saysElite floor={s.startFloor} />
          <ScopeFunctions detail={detail} />
          <p className="print-only chart-subtitle">{c.functions.printNote}</p>
        </>
      )}
      {partly.length > 0 && (
        <aside className="notice notice-warning">
          <p className="notice-title">{s.partly.title}</p>
          <p>{s.partly.body(partly.length)}</p>
        </aside>
      )}
    </section>
  );
}

function DetailBody({ detail, clearArea, busy }: { detail: CodeDetailReport; clearArea: () => void; busy: boolean }) {
  return (
    <div className={busy ? "detail-body is-refreshing" : "detail-body"} aria-busy={busy}>
      <Notices detail={detail} clearArea={clearArea} />
      <AreasCard detail={detail} />
      <SelectedScope detail={detail} />
      <CoveragePanel detail={detail} />
    </div>
  );
}

function Outcome({ data, clearArea, busy }: { data: CodeDetailResponse; clearArea: () => void; busy: boolean }) {
  if (data.status === "ok") return <DetailBody detail={data} clearArea={clearArea} busy={busy} />;
  if (data.status === "error") {
    return (
      <div className="notice notice-error" role="alert">
        <p className="notice-title">{c.error.title}</p>
        <p>{data.message}</p>
        <p>{c.error.when(formatDateTime(data.analysedAt))}</p>
      </div>
    );
  }
  return (
    <EmptyState title={c.none.title}>
      <p>{c.none.body}</p>
    </EmptyState>
  );
}

function GradeLine({ repoId }: { repoId: number }) {
  const [range] = useRangeParams();
  const health = useCodeHealth(repoId, { from: range.from, to: range.to });
  const band = health.data?.status === "ok" ? (health.data.grade?.overall.band ?? null) : null;
  if (!health.data) {
    return health.isError ? <p className="grade-line">{c.gradeUnavailable}</p> : null;
  }
  return (
    <p className="grade-line">
      <span>{band ? c.gradeLine : c.gradeNone}</span> {band && <BandLabel band={band} />}
    </p>
  );
}

function CodeAnalysisView({ id }: { id: number }) {
  const { search } = useLocation();
  const [area] = useTextParam("area");
  const navigate = useNavigate();
  const detail = useCodeDetail(id, area);
  const repos = useRepos();
  const listing = repos.data?.find((repo) => repo.id === id);
  const data = detail.data;

  return (
    <div className="page">
      <StickyPanel>
        <Link to={{ pathname: `/repos/${id}`, search: searchWithArea(search, null) }} className="back-link">
          {c.backToRepo}
        </Link>
        <header className="page-header page-header-row">
          <div className="page-header">
            <h1>{c.title}</h1>
            <p className="lede">{listing ? repoName(listing) : copy.repo.loadingTitle}</p>
            {data?.status === "ok" && (
              <p className="lede">{c.analysedAt(shortSha(data.commitSha), formatDateTime(data.analysedAt))}</p>
            )}
            <GradeLine repoId={id} />
          </div>
          {listing && <DownloadReportButton subject={repoName(listing)} label={c.reportLabel} />}
        </header>
      </StickyPanel>
      <p className="lede">{c.lede}</p>

      {detail.isPending && <SkeletonGrid count={4} height={120} label={c.loading} />}
      {detail.isError && <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />}
      {data && (
        <Outcome
          data={data}
          clearArea={() => navigate({ search: searchWithArea(search, null) })}
          busy={detail.isPlaceholderData}
        />
      )}
    </div>
  );
}

/** The detailed code analysis of one repository, at /repos/:id/code, scoped to an area by ?area=. */
export function CodeAnalysisPage() {
  const id = Number(useParams().id);
  // An address that does not name a repository is answered here, without asking the API.
  if (!isRecordId(id)) {
    return (
      <div className="page">
        <Link to="/repos" className="back-link">
          {copy.common.backToRepos}
        </Link>
        <EmptyState title={c.notFound} />
      </div>
    );
  }
  return <CodeAnalysisView id={id} />;
}
