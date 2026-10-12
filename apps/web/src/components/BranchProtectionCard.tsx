import type { SecurityReport } from "@dora-dashboard/core";
import { copy } from "../copy";
import { formatDateTime } from "../lib/format";
import {
  advisoriesText,
  branchDetailLine,
  branchProtectedLine,
  hasNotVisible,
  postureAbout,
  ruleRows,
  settingRows,
  type RuleRow,
} from "../lib/security";
import { PassFail } from "./PassFail";
import { SecurityBlock } from "./SecurityParts";

const c = copy.security.branch;

function Rows({ rows }: { rows: RuleRow[] }) {
  return (
    <ul className="check-rows">
      {rows.map((row) => (
        <li key={row.key} className="check-row">
          <div className="check-row-head">
            <PassFail state={row.state} label={row.stateLabel} />
            <span className="check-row-title">{row.label}</span>
          </div>
          <p className="check-row-text">
            {row.hint}
            {row.detail && ` ${row.detail}`}
          </p>
        </li>
      ))}
    </ul>
  );
}

/** Rules on the deploy branch, repository settings and advisories, each as met, not met or not visible. */
export function BranchProtectionCard({ report }: { report: SecurityReport }) {
  const held = report.posture;
  const failure = report.postureFailure;
  if (!held) {
    return (
      <SecurityBlock id="security-branch" title={c.title} lede={c.lede}>
        {failure ? (
          <div className="notice notice-warning">
            <p>{c.failedNone(failure.message)}</p>
          </div>
        ) : (
          <div className="notice notice-info">
            <p>{c.notRead}</p>
          </div>
        )}
      </SecurityBlock>
    );
  }
  const posture = held.value;
  const rules = ruleRows(posture);
  const settings = settingRows(posture);
  const hidden = hasNotVisible(posture, [...rules, ...settings]);
  const detail = branchDetailLine(posture);
  return (
    <SecurityBlock id="security-branch" title={c.title} lede={c.lede}>
      <div className="card">
        {failure && <p className="chart-subtitle">{c.failedKept(failure.message)}</p>}
        <p>{postureAbout(posture)}</p>
        <p className="chart-subtitle">
          {branchProtectedLine(posture)}
          {detail && ` ${detail}`}
          {` ${c.readOn(formatDateTime(held.readAt))}.`}
        </p>
        <h3 className="chart-title">{c.rulesTitle}</h3>
        <Rows rows={rules} />
        <h3 className="chart-title">{c.settingsTitle}</h3>
        <Rows rows={settings} />
        <h3 className="chart-title">{c.advisoriesTitle}</h3>
        <p>{advisoriesText(posture)}</p>
      </div>
      {hidden && (
        <aside className="notice notice-info">
          <p className="notice-title">{c.notVisibleTitle}</p>
          <p>{c.notVisible}</p>
        </aside>
      )}
    </SecurityBlock>
  );
}
