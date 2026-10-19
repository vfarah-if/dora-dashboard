import type { SecurityReport } from "@dora-dashboard/core";
import { copy } from "../copy";
import { chainAnchor, goodAndImprove, gradeNote, partRows, unmeasuredSentences, verdictSentence } from "../lib/security";
import { PathText } from "./PathText";
import { GradeTile } from "./GradeTile";
import { SecurityBlock } from "./SecurityParts";
import { StatTile } from "./StatTile";

const c = copy.security;

function Lists({ report }: { report: SecurityReport }) {
  const { good, improve } = goodAndImprove(report);
  return (
    <div className="findings-grid">
      <section aria-labelledby="security-good-title" className="card">
        <h3 id="security-good-title" className="chart-title">
          {c.grade.goodTitle}
        </h3>
        {good.length === 0 ? (
          <p className="chart-empty">{c.grade.goodEmpty}</p>
        ) : (
          <ul className="findings-list findings-good">
            {good.map((line) => (
              <li key={line.check}>{line.text}</li>
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="security-improve-title" className="card">
        <h3 id="security-improve-title" className="chart-title">
          {c.grade.improveTitle}
        </h3>
        <p className="chart-subtitle">{c.grade.improveHint}</p>
        {improve.length === 0 ? (
          <p className="chart-empty">{c.grade.improveEmpty}</p>
        ) : (
          <ol className="findings-list findings-improve">
            {improve.map((line) => (
              <li key={line.check}>
                {line.text}
                {line.sets && (
                  <span className="check-limit">{line.sets === "grade" ? c.tags.setsGrade : c.tags.setsPartGrade}</span>
                )}
                {line.files.length > 0 && (
                  <span className="check-files mono">
                    {line.files.map((file) => (
                      <span key={file} className="block">
                        <PathText text={file} />
                      </span>
                    ))}
                  </span>
                )}
                {chainAnchor(line.check) && (
                  <a className="check-see-places screen-only" href={`#${chainAnchor(line.check)}`}>
                    {c.chain.seeEachPlace}
                  </a>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

/** The grade as one large tile, its three parts and what is going well and what to improve. */
export function SecurityGrade({ report }: { report: SecurityReport }) {
  const grade = report.grade;
  if (!grade) {
    return (
      <SecurityBlock id="security-grade" title={c.grade.title}>
        <div className="notice notice-info">
          <p>{c.start.missing[report.gradeMissing ?? "nothing_measured"]}</p>
        </div>
      </SecurityBlock>
    );
  }
  return (
    <SecurityBlock id="security-grade" title={c.grade.title} lede={c.grade.definition}>
      <GradeTile
        large
        title={c.grade.title}
        band={grade.overall.band}
        detail={verdictSentence(report) ?? ""}
        note={gradeNote(report)}
      />
      <h3 className="chart-title">{c.grade.partsTitle}</h3>
      <div className="grade-grid">
        {partRows(report).map((part) =>
          part.band ? (
            <GradeTile
              key={part.part}
              title={part.name}
              band={part.band}
              detail={part.detail}
              definition={part.definition}
              note={part.note}
            />
          ) : (
            <StatTile key={part.part} label={part.name} value={c.notMeasured} hint={part.definition} />
          ),
        )}
      </div>
      <Lists report={report} />
      {grade.unmeasured.length > 0 && (
        <aside className="notice notice-info">
          <p className="notice-title">{c.grade.unmeasuredTitle}</p>
          <ul className="plain-list">
            {unmeasuredSentences(grade.unmeasured).map((sentence) => (
              <li key={sentence}>{sentence}</li>
            ))}
          </ul>
        </aside>
      )}
    </SecurityBlock>
  );
}
