import { Link, useLocation } from "react-router";
import type { CodeDetailReport } from "@dora-dashboard/core";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { copy } from "../copy";
import { areaChartRows, areaLabel, searchWithArea } from "../lib/codeDetail";
import { formatNumber, formatPercent } from "../lib/format";
import { usePrinting } from "../lib/print";
import { seriesColour } from "../lib/series";
import { BandLabel } from "./BandLabel";
import { ChartCard } from "./ChartCard";
import { axisProps, categoryAxisProps, CHART_HEIGHT, ChartTooltip, PRINT_CHART_WIDTH } from "./chartParts";
import { ShowAllList } from "./ShowAllList";

const BAR_HEIGHT = 32;
const AXIS_HEIGHT = 48;

function AreaBars({ rows }: { rows: ReturnType<typeof areaChartRows>["bars"] }) {
  // The chart spans the section, so it is drawn at the printed page's width while printing.
  const printing = usePrinting();
  const axis = categoryAxisProps(rows.map((row) => row.label));
  const height = Math.min(CHART_HEIGHT * 2, AXIS_HEIGHT + rows.length * BAR_HEIGHT);
  return (
    <ResponsiveContainer width={printing ? PRINT_CHART_WIDTH : "100%"} height={height}>
      <BarChart data={rows} layout="vertical" margin={{ top: 8, right: 24, bottom: 0, left: 0 }}>
        <CartesianGrid stroke="var(--grid)" horizontal={false} />
        <XAxis type="number" {...axisProps} allowDecimals={false} />
        <YAxis type="category" dataKey="label" {...axisProps} {...axis} interval={0} />
        <Tooltip
          content={<ChartTooltip formatValue={(value) => formatNumber(value, 0)} />}
          cursor={{ fill: "var(--surface-sunken)" }}
        />
        <Bar
          dataKey="lines"
          name={copy.codeAnalysis.areas.chart.series}
          fill={seriesColour(0)}
          radius={[0, 2, 2, 0]}
          isAnimationActive={false}
        />
      </BarChart>
    </ResponsiveContainer>
  );
}

/** The chart of complex lines by area, whose table behind the disclosure carries every area. */
export function AreasChart({ detail }: { detail: CodeDetailReport }) {
  const c = copy.codeAnalysis.areas.chart;
  const { bars, all } = areaChartRows(detail.areas.items);
  return (
    <ChartCard
      title={c.title}
      subtitle={c.subtitle(detail.thresholds.warn)}
      empty={all.every((row) => row.lines === 0)}
      xLabel={c.x}
      note={all.length > bars.length ? <p>{c.capped(bars.length, all.length)}</p> : undefined}
      table={{ columns: [copy.codeAnalysis.areas.table.area, c.series], rows: all.map((row) => [row.label, row.lines]) }}
    >
      <AreaBars rows={bars} />
    </ChartCard>
  );
}

/** The area table, each row linking to the page scoped to that area while keeping the other address parameters. */
function AreaTable({ detail }: { detail: CodeDetailReport }) {
  const c = copy.codeAnalysis.areas;
  const { search } = useLocation();
  const t = c.table;
  const areas = detail.areas.items;
  return (
    <>
      <ShowAllList total={areas.length}>
        {(limit) => (
          <div className="table-scroll">
            <table className="data-table area-table">
              <caption className="visually-hidden">{detail.mode === "workspace" ? c.packagesTitle : c.foldersTitle}</caption>
              <thead>
                <tr>
                  <th scope="col">{t.area}</th>
                  <th scope="col" className="numeric">
                    {t.files}
                  </th>
                  <th scope="col" className="numeric">
                    {t.functions}
                  </th>
                  <th scope="col" className="numeric">
                    {t.nloc}
                  </th>
                  <th scope="col" className="numeric">
                    {t.above(detail.thresholds.warn)}
                  </th>
                  <th scope="col" className="numeric">
                    {t.mean}
                  </th>
                  <th scope="col">{t.band}</th>
                  <th scope="col" className="numeric">
                    {t.coverage}
                  </th>
                </tr>
              </thead>
              <tbody>
                {areas.slice(0, limit).map((a) => {
                  const selected = detail.area === a.path;
                  return (
                    <tr key={a.path} className={selected ? "row-selected" : undefined}>
                      <th scope="row" className="mono wrap-anywhere">
                        <Link to={{ search: searchWithArea(search, a.path) }} aria-current={selected ? "true" : undefined}>
                          {areaLabel(a.path)}
                        </Link>
                        {selected && <span className="start-tag">{t.selected}</span>}
                      </th>
                      <td className="numeric">{formatNumber(a.files, 0)}</td>
                      <td className="numeric">{formatNumber(a.functions, 0)}</td>
                      <td className="numeric">{formatNumber(a.nloc, 0)}</td>
                      <td className="numeric">{formatNumber(a.countAboveWarn, 0)}</td>
                      <td className="numeric">{formatNumber(a.meanCcn, 1)}</td>
                      <td>{a.maintainabilityBand ? <BandLabel band={a.maintainabilityBand} /> : t.noBand}</td>
                      <td className="numeric">{a.coverage === null ? t.noCoverage : formatPercent(a.coverage)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </ShowAllList>
      {detail.areas.total > areas.length && <p className="chart-subtitle">{c.capped(areas.length, detail.areas.total)}</p>}
    </>
  );
}

/** The areas of the repository: a chart of complex lines and a table to choose an area from. */
export function AreasCard({ detail }: { detail: CodeDetailReport }) {
  const c = copy.codeAnalysis.areas;
  const { search } = useLocation();
  const heading = detail.mode === "workspace" ? c.packagesTitle : c.foldersTitle;
  return (
    <section aria-labelledby="areas-title" className="section">
      <h2 id="areas-title" className="section-title">
        {heading}
      </h2>
      <p className="section-lede">{detail.mode === "workspace" ? c.subtitleWorkspace : c.subtitleFolder}</p>
      <p className="chart-subtitle">{c.bandNote}</p>
      {detail.areas.items.length === 0 ? (
        <p className="chart-empty">{c.empty}</p>
      ) : (
        <>
          <AreasChart detail={detail} />
          <div className="card">
            <p>
              <Link to={{ search: searchWithArea(search, null) }} aria-current={detail.area === null ? "true" : undefined}>
                {c.wholeRepository}
              </Link>
            </p>
            <AreaTable detail={detail} />
          </div>
        </>
      )}
    </section>
  );
}
