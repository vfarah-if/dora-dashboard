import type { SecurityReport, SupplyChainLine } from "@dora-dashboard/core";
import { copy } from "../copy";
import { formatDateTime } from "../lib/format";
import { shortSha } from "../lib/codeHealth";
import { foundBy, groupLines, lineState, supplyChainSentence, supplyChainTitle, type SupplyChainGroup } from "../lib/security";
import { AcceptFinding } from "./AcceptFinding";
import { FindingRow } from "./FindingRow";
import { PassFail } from "./PassFail";
import { PathText } from "./PathText";
import { SecurityBlock, SecurityList, Tag } from "./SecurityParts";

const c = copy.security.chain;
const ITEM_LIMIT = 5;

function Items({ repoId, line }: { repoId: number; line: SupplyChainLine }) {
  const what = copy.space.forCheck(supplyChainTitle[line.check]);
  if (line.items.length === 0) return null;
  return (
    <>
      <SecurityList total={line.items.length} limit={ITEM_LIMIT} what={what}>
        {(limit) => (
          <ul className="check-items finding-rows">
            {line.items.slice(0, limit).map((item, index) => (
              <FindingRow
                key={
                  item.fingerprint === null
                    ? `none|${index}|${item.path}:${item.line ?? ""}`
                    : `${item.fingerprint}|${item.path}:${item.line ?? ""}`
                }
                repoId={repoId}
                line={line}
                item={item}
              />
            ))}
          </ul>
        )}
      </SecurityList>
      {line.total > line.items.length && <p className="chart-subtitle">{c.totalNote(line.items.length, line.total)}</p>}
    </>
  );
}

/**
 * A quiet note that some files were listed in the repository but not read, with the paths behind a button. `total` can
 * exceed the paths when core cut the list, and the note says so.
 */
function UnreadNote({
  sentence,
  paths,
  total,
  what,
}: {
  sentence: string;
  paths: readonly string[];
  total: number;
  what: string;
}) {
  return (
    <div>
      <p className="chart-subtitle">{sentence}</p>
      <SecurityList total={paths.length} limit={ITEM_LIMIT} what={what}>
        {(limit) => (
          <ul className="check-items mono">
            {paths.slice(0, limit).map((path) => (
              <li key={path}>
                <PathText text={path} />
              </li>
            ))}
          </ul>
        )}
      </SecurityList>
      {total > paths.length && <p className="chart-subtitle">{c.totalNote(paths.length, total)}</p>}
    </div>
  );
}

/** The checks of one section, each with a result as an icon and a word, a sentence and what was found. */
export function SupplyChainLines({ report, group }: { report: SecurityReport; group: SupplyChainGroup }) {
  const lines = groupLines(report, group);
  if (report.supplyChain.status === "none") {
    return (
      <div className="notice notice-info">
        <p>{c.none[report.supplyChain.reason]}</p>
      </div>
    );
  }
  if (lines.length === 0) return <p className="chart-empty">{c.nothingFound}</p>;
  return (
    <ul className="check-rows">
      {lines.map((line) => (
        <li key={line.check} id={`chain-${line.check}`} className="check-row">
          <div className="check-row-head">
            <PassFail state={lineState(line)} />
            <span className="check-row-title">{supplyChainTitle[line.check]}</span>
            <Tag>{line.graded ? copy.security.tags.countsTowardsGrade : copy.security.tags.advice}</Tag>
          </div>
          <p className="check-row-text">{supplyChainSentence(line)}</p>
          <p className="chart-subtitle check-found-by">
            <span className="visually-hidden">{c.foundByLabel}. </span>
            {foundBy[line.check]}
          </p>
          <Items repoId={report.repo.id} line={line} />
          {line.absence && (
            <AcceptFinding
              repoId={report.repo.id}
              target={{ check: line.check, path: null, fingerprint: line.absence.fingerprint }}
              place={supplyChainTitle[line.check]}
            />
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * One section of the supply chain checks, such as workflows, security tools in CI or container images. When the files
 * have not been read, the workflows section says so once and the others stand down, instead of repeating the notice.
 */
export function SupplyChainCard({ report, group }: { report: SecurityReport; group: SupplyChainGroup }) {
  const text = c[group];
  const chain = report.supplyChain;
  if (chain.status === "none" && group !== "workflows") return null;
  return (
    <SecurityBlock id={`security-${group}`} title={text.title} lede={text.lede}>
      {group === "workflows" && chain.status === "ok" && (
        <p className="chart-subtitle">{c.readOn(shortSha(chain.commitSha), formatDateTime(chain.readAt), chain.workflowsRead)}</p>
      )}
      {group === "workflows" && chain.status === "ok" && chain.findingsDropped + chain.actionsDropped > 0 && (
        <p className="chart-subtitle">{c.dropped(chain.findingsDropped, chain.actionsDropped)}</p>
      )}
      {group === "workflows" && chain.status === "ok" && chain.workflowsUnread.length > 0 && (
        <UnreadNote
          sentence={c.unread(chain.workflowsUnread.length)}
          paths={chain.workflowsUnread}
          total={chain.workflowsUnread.length}
          what={c.workflowsUnreadWhat}
        />
      )}
      {group === "images" && chain.status === "ok" && chain.dockerfilesUnreadTotal > 0 && (
        <UnreadNote
          sentence={c.dockerfilesUnread(chain.dockerfilesUnreadTotal)}
          paths={chain.dockerfilesUnread}
          total={chain.dockerfilesUnreadTotal}
          what={c.dockerfilesUnreadWhat}
        />
      )}
      <div className="card">
        <SupplyChainLines report={report} group={group} />
      </div>
    </SecurityBlock>
  );
}
