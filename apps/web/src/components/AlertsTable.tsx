import type { SecurityAlertRef, SecurityReport } from "@dora-dashboard/core";
import { copy } from "../copy";
import { formatDuration } from "../lib/format";
import {
  ALERT_SOURCES,
  SEVERITY_COLOUR,
  alertWhere,
  filterAlerts,
  parseAlertSource,
  sourceName,
  weaknessName,
} from "../lib/security";
import { safeHttpUrl } from "../lib/security";
import { useTextParam } from "../lib/urlState";
import { ExternalLink } from "./ExternalLink";
import { PathText } from "./PathText";
import { LikelyExploitedTag, SecurityBlock, SeverityTag, Tag } from "./SecurityParts";
import { ShowAllList } from "./ShowAllList";

const c = copy.security.alerts;

function Row({ alert }: { alert: SecurityAlertRef }) {
  const url = safeHttpUrl(alert.url);
  return (
    <tr>
      <th scope="row">
        <SeverityTag severity={alert.severity} colour={SEVERITY_COLOUR[alert.severity]} />
      </th>
      <td>
        {url ? <ExternalLink href={url}>{alert.title}</ExternalLink> : alert.title}
        <span className="alert-tags">
          {alert.likelyExploited && <LikelyExploitedTag />}
          {alert.cvssScore !== null && <Tag>{copy.security.cvss(alert.cvssScore)}</Tag>}
          {alert.cwes.map((cwe) => (
            <Tag key={cwe}>{weaknessName(cwe)}</Tag>
          ))}
        </span>
      </td>
      <td className="mono">
        <PathText text={alertWhere(alert.where)} />
      </td>
      <td>{sourceName(alert.source)}</td>
      <td className="numeric">{formatDuration(alert.ageHours)}</td>
      <td>
        {alert.pastFix ? <Tag tone="danger">{copy.security.tags.pastFix}</Tag> : <span>{copy.security.tags.withinFix}</span>}
      </td>
    </tr>
  );
}

/** The worst open alerts, with a filter by source held in the address so a view can be shared. It prints in full. */
export function AlertsTable({ report }: { report: SecurityReport }) {
  const [raw, setSource] = useTextParam("source");
  const source = parseAlertSource(raw);
  const alerts = filterAlerts(report.openAlerts, source);
  return (
    <SecurityBlock id="security-alerts" title={c.title} lede={c.subtitle}>
      <div className="card">
        <div className="table-filter screen-only">
          <label htmlFor="alert-source">{c.filterLabel}</label>
          <select
            id="alert-source"
            className="input"
            value={source ?? ""}
            onChange={(event) => setSource(event.target.value || null)}
          >
            <option value="">{c.filterAll}</option>
            {ALERT_SOURCES.map((s) => (
              <option key={s} value={s}>
                {c.filterOption(sourceName(s), report.open.bySource[s])}
              </option>
            ))}
          </select>
        </div>
        {source && <p className="print-only">{c.filterNote(sourceName(source))}</p>}
        {report.openAlertTotal > report.openAlerts.length && (
          <p className="chart-subtitle">{c.capped(report.openAlerts.length, report.openAlertTotal)}</p>
        )}
        {alerts.length === 0 ? (
          <p className="chart-empty">{c.none}</p>
        ) : (
          <ShowAllList total={alerts.length}>
            {(limit) => (
              <div className="table-scroll">
                <table className="data-table alerts-table">
                  <caption className="visually-hidden">{c.title}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{c.severity}</th>
                      <th scope="col">{c.problem}</th>
                      <th scope="col">{c.where}</th>
                      <th scope="col">{c.source}</th>
                      <th scope="col">{c.age}</th>
                      <th scope="col">{c.fixBy}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {alerts.slice(0, limit).map((alert) => (
                      <Row key={`${alert.source}-${alert.key}`} alert={alert} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </ShowAllList>
        )}
      </div>
    </SecurityBlock>
  );
}
