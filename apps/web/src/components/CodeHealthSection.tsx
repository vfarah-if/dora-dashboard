import type { CodeHealthReport } from "@dora-dashboard/core";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useCodeHealth } from "../api/hooks";
import { copy } from "../copy";
import { distributionIsEmpty, distributionRows, locationLabel, shortSha } from "../lib/codeHealth";
import { formatDate, formatDateTime, formatNumber, formatPercent } from "../lib/format";
import { seriesColour } from "../lib/series";
import { ChartCard } from "./ChartCard";
import { axisProps, CHART_HEIGHT, ChartTooltip, gridProps } from "./chartParts";
import { StatTile } from "./StatTile";
import { EmptyState, ErrorState, SkeletonGrid } from "./States";

const WARN = 10;

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

function CodeHealthReportView({ report }: { report: CodeHealthReport }) {
  const rows = distributionRows(report);
  const c = copy.codeHealth;
  return (
    <>
      <p className="chart-subtitle">{c.analysedAt(shortSha(report.commitSha), formatDateTime(report.analysedAt))}</p>
      {report.lastError && (
        <aside className="notice notice-warning" role="status">
          <p className="notice-title">{c.staleTitle}</p>
          <p>{c.stale(formatDate(report.analysedAt), formatDate(report.lastError.analysedAt), report.lastError.message)}</p>
        </aside>
      )}
      <div className="tile-grid tile-grid-flow">
        <StatTile label={c.medianCcn} value={formatNumber(report.ccn.median, 0)} hint={c.medianCcnHint} />
        <StatTile label={c.p75Ccn} value={formatNumber(report.ccn.p75, 0)} hint={c.p75CcnHint(formatNumber(report.ccn.max, 0))} />
        <StatTile
          label={c.shareAbove(WARN)}
          value={formatPercent(report.shareAboveWarn)}
          hint={c.shareAboveHint(formatPercent(report.shareAboveHigh), 20)}
        />
        <StatTile label={c.nloc} value={formatNumber(report.nloc, 0)} hint={c.nlocHint} />
        <StatTile label={c.functions} value={formatNumber(report.functions, 0)} hint={c.functionsHint} />
      </div>

      <ChartCard
        title={c.chart.title}
        subtitle={c.chart.subtitle}
        empty={distributionIsEmpty(rows)}
        xLabel={c.chart.x}
        table={{ columns: [c.chart.x, c.chart.series], rows: rows.map((r) => [r.label, r.count]) }}
      >
        <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
          <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
            <CartesianGrid {...gridProps} />
            <XAxis dataKey="label" {...axisProps} />
            <YAxis {...axisProps} allowDecimals={false} />
            <Tooltip
              content={<ChartTooltip formatValue={(value) => formatNumber(value, 0)} />}
              cursor={{ fill: "var(--surface-sunken)" }}
            />
            <Bar dataKey="count" name={c.chart.series} fill={seriesColour(0)} radius={[2, 2, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      <section aria-labelledby="hotspots-title" className="card">
        <h3 id="hotspots-title" className="chart-title">
          {c.hotspots.title}
        </h3>
        <p className="chart-subtitle">{c.hotspots.subtitle}</p>
        <Hotspots report={report} />
      </section>

      <aside className="notice notice-info">
        <p className="notice-title">{c.explainerTitle}</p>
        <p>{c.explainer}</p>
      </aside>
    </>
  );
}

/** The code health section of the repository page, covering loading, empty, error and ok states. */
export function CodeHealthSection({ repoId }: { repoId: number }) {
  const health = useCodeHealth(repoId);
  const data = health.data;
  const c = copy.codeHealth;
  return (
    <section aria-labelledby="code-health-title" className="section">
      <h2 id="code-health-title" className="section-title">
        {c.title}
      </h2>
      <p className="section-lede">{c.lede}</p>
      {health.isPending && <SkeletonGrid count={4} height={120} label={c.loading} />}
      {health.isError && <ErrorState error={health.error} onRetry={() => void health.refetch()} />}
      {data?.status === "none" && (
        <EmptyState title={c.none.title}>
          <p>{c.none.body}</p>
        </EmptyState>
      )}
      {data?.status === "error" && (
        <div className="notice notice-error" role="alert">
          <p className="notice-title">{c.error.title}</p>
          <p>{data.message}</p>
          <p>{c.error.install}</p>
          <p>{c.error.when(formatDateTime(data.analysedAt))}</p>
        </div>
      )}
      {data?.status === "ok" && <CodeHealthReportView report={data} />}
    </section>
  );
}
