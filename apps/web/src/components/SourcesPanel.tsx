import type { SecurityReport } from "@dora-dashboard/core";
import { copy } from "../copy";
import { formatDateTime } from "../lib/format";
import { safeHttpUrl, sourceLines } from "../lib/security";
import { ExternalLink } from "./ExternalLink";
import { PassFail } from "./PassFail";
import { SecurityBlock } from "./SecurityParts";

const c = copy.security.sources;

/** Where the figures come from, what was read when, what was not and how to switch each one on. */
export function SourcesPanel({ report }: { report: SecurityReport }) {
  const settingsUrl = safeHttpUrl(report.settingsUrl);
  return (
    <SecurityBlock id="security-sources" title={c.title} lede={c.lede}>
      <ul className="source-list">
        {sourceLines(report).map((line) => (
          <li key={line.id} className="card source-row">
            <h3 className="chart-title">{line.name}</h3>
            <PassFail state={line.tone} label={line.stateLabel} />
            {line.detail && <p>{line.detail}</p>}
            <p className="chart-subtitle">{line.readAt ? c.readOn(formatDateTime(line.readAt)) : c.notYet}</p>
            {line.enable && (
              <p>
                <strong>{c.howTo}</strong> {line.enable}
                {line.id === "dependabot" && (
                  <> {settingsUrl && <ExternalLink href={settingsUrl}>{copy.security.settingsLink}</ExternalLink>}</>
                )}
              </p>
            )}
          </li>
        ))}
      </ul>
    </SecurityBlock>
  );
}
