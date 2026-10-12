import type { DependencyGroup, SecurityReport } from "@dora-dashboard/core";
import { copy } from "../copy";
import { SEVERITY_COLOUR, joinWords } from "../lib/security";
import { upgradeAdvice } from "../lib/securityFixes";
import { PathText } from "./PathText";
import { LikelyExploitedTag, SecurityBlock, SecurityList, SeverityTag } from "./SecurityParts";

const c = copy.security.upgrades;

function UpgradeTo({ group }: { group: DependencyGroup }) {
  if (group.upgradeTo) return <span>{group.upgradeTo}</span>;
  if (group.patchedVersions.length > 0) return <span>{c.several(joinWords(group.patchedVersions))}</span>;
  return <span>{c.noFix}</span>;
}

function Command({ group }: { group: DependencyGroup }) {
  // Without one fixed version there is nothing to install, whatever the package manager, so say that and not that the
  // manager is unknown.
  if (!group.upgradeTo) return <span>{group.patchedVersions.length > 0 ? c.chooseVersion : c.nothingToInstall}</span>;
  const advice = upgradeAdvice({
    ecosystem: group.ecosystem,
    manifestPath: group.manifestPath,
    name: group.name,
    version: group.upgradeTo,
    relationship: group.relationship,
  });
  if (advice === null) return <span>{group.name === null ? c.noCommandUnnamed : c.noCommand}</span>;
  // A command is code to run. An instruction is words, so it is not drawn as code and has nothing to copy.
  return advice.kind === "command" ? <code className="inline-command">{advice.command}</code> : <span>{advice.text}</span>;
}

/** A key that never prints "null". Unnamed packages have nothing to tell them apart, so their place does. */
const groupKey = (group: DependencyGroup, index: number): string =>
  `${group.ecosystem ?? ""}:${group.name ?? `unnamed-${index}`}:${group.manifestPath ?? ""}`;

function Row({ group }: { group: DependencyGroup }) {
  return (
    <tr>
      <th scope="row">
        <span className="mono">{group.name ?? c.unnamed}</span>
        {group.ecosystem && <span className="cell-note">{group.ecosystem}</span>}
        {group.relationship && <span className="cell-note">{c.relationship[group.relationship]}</span>}
        {group.likelyExploited && <LikelyExploitedTag />}
      </th>
      <td className="mono">
        <span className="block">
          <PathText text={group.manifestPath ?? c.noManifest} />
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
          <SecurityList total={groups.length}>
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
                    {groups.slice(0, limit).map((group, index) => (
                      <Row key={groupKey(group, index)} group={group} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </SecurityList>
        )}
      </div>
    </SecurityBlock>
  );
}
