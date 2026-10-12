import type { SecurityReport } from "@dora-dashboard/core";
import { copy } from "../copy";
import { ACTION_EFFORT, actionSentence, startHere } from "../lib/security";
import { BandLabel } from "./BandLabel";
import { EffortTag } from "./SecurityParts";

const c = copy.security.start;

/**
 * The card at the very top of the security report. It gives the grade, what it takes to reach the next band and the
 * first three things to do, each with how much work it is, or a plain good word when nothing needs fixing.
 */
export function StartHere({ report }: { report: SecurityReport }) {
  const start = startHere(report);
  return (
    <section aria-labelledby="start-here-title" className="card start-card start-here" id="start-here">
      <h2 id="start-here-title" className="section-title">
        {c.title}
      </h2>
      {start.band === null ? (
        <p>{c.missing[report.gradeMissing ?? "nothing_measured"]}</p>
      ) : (
        <>
          <p className="band-line">
            <span>{c.gradeIs}</span> <BandLabel band={start.band} />
          </p>
          {start.nothingToFix ? (
            <p>{c.good}</p>
          ) : (
            <>
              <p>
                {start.raise
                  ? c.raise(
                      start.raise.count,
                      copy.dora.band[start.raise.from].toLowerCase(),
                      copy.dora.band[start.raise.to].toLowerCase(),
                    )
                  : c.nothingToRaise(copy.dora.band[start.band].toLowerCase())}
              </p>
              <ol className="start-actions">
                {start.top.shown.map((action) => (
                  <li key={`${action.kind}-${action.target ?? ""}-${action.manifestPath ?? ""}`}>
                    <span>{actionSentence(action, report.dependabotVersionUpdates, report.thresholds)}</span>{" "}
                    <EffortTag effort={ACTION_EFFORT[action.kind]} />
                  </li>
                ))}
              </ol>
              <p className="chart-subtitle">
                {start.top.more > 0 && <>{c.more(start.top.more)} </>}
                <a href="#security-actions">{c.seeAll}</a>
              </p>
              {start.adviceCount > 0 && <p className="chart-subtitle">{c.advice(start.adviceCount)}</p>}
            </>
          )}
        </>
      )}
    </section>
  );
}
