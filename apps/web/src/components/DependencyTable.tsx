import type { DependencyGroup, SecurityReport } from "@dora-dashboard/core";
import { copy } from "../copy";
import { SEVERITY_COLOUR, joinWords } from "../lib/security";
import { upgradeAdvice } from "../lib/securityFixes";
import { PathText } from "./PathText";
import { LikelyExploitedTag, SecurityBlock, SeverityTag } from "./SecurityParts";
import { ShowAllList } from "./ShowAllList";

const c = copy.security.upgrades;

function UpgradeTo({ group }: { group: DependencyGroup }) {
  if (group.upgradeTo) return <span>{group.upgradeTo}</span>;
  if (group.patchedVersions.length > 0) return <span>{c.several(joinWords(group.patchedVersions))}</span>;
  return <span>{c.noFix}</span>;
}

function Command({ group }: { group: DependencyGroup }) {
  const advice = upgradeAdvice({
    ecosystem: group.ecosystem,
    manifestPath: group.manifestPath,
    name: group.name,
    version: group.upgradeTo,
    relationship: group.relationship,
  });
  if (advice === null) return <span>{c.noCommand}</span>;
  // A command is code to run. An instruction is words, so it is not drawn as code and has nothing to copy.
  return advice.kind === "command" ? <code className="inline-command">{advice.command}</code> : <span>{advice.text}</span>;
}

function Row({ group }: { group: DependencyGroup }) {
  return (
    <tr>
      <th scope="row">
        <span className="mono">{group.name}</span>
        <span className="cell-note">{group.ecosystem}</span>
        {group.relationship && <span className="cell-note">{c.relationship[group.relationship]}</span>}
        {group.likelyExploited && <LikelyExploitedTag />}
      </th>
      <td className="mono">
        <span className="block">
          <PathText text={group.manifestPath} />
        </span>
        {group.lockedVersions.length > 0 && (
          <span className="block cell-note">{c.lockedAt(joinWords(group.lockedVersions))}</span>
        )}
      </td>
      <td className="numeric">{group.alerts}</td>
      <td>
        <SeverityTag severity={group.worstSeverity} colour={SEVERITY_COLOUR[group.worstSeverity]} />
      </td>
      <td>
        <UpgradeTo group={group} />
      </td>
      <td>
        <Command group={group} />
      </td>
      <td className="numeric">{group.pastFix > 0 ? c.pastFixCount(group.pastFix) : c.noneText}</td>
    </tr>
  );
}

/** The packages with open alerts, worst first, each with the version that fixes it and the command that upgrades it. */
export function DependencyTable({ groups }: { groups: SecurityReport["dependencyGroups"] }) {
  return (
    <SecurityBlock id="security-upgrades" title={c.title} lede={c.lede}>
      <div className="card">
        {groups.length === 0 ? (
          <p className="chart-empty">{c.none}</p>
        ) : (
          <ShowAllList total={groups.length}>
            {(limit) => (
              <div className="table-scroll">
                <table className="data-table">
                  <caption className="visually-hidden">{c.subtitle}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{c.package}</th>
                      <th scope="col">{c.files}</th>
                      <th scope="col">{c.alerts}</th>
                      <th scope="col">{c.worst}</th>
                      <th scope="col">{c.upgradeTo}</th>
                      <th scope="col">{c.command}</th>
                      <th scope="col">{c.pastFix}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {groups.slice(0, limit).map((group) => (
                      <Row key={`${group.ecosystem}:${group.name}:${group.manifestPath}`} group={group} />
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
