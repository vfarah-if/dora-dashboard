import { copy } from "../copy";

/**
 * Explanatory diagrams for the home page. They illustrate ideas rather than plot data, so each carries
 * an accessible name and the same content is always written out as text beside it.
 */

const NODE_X = [60, 160, 260, 360, 460];
const NODE_Y = 120;
const NODE_COLOURS = ["var(--series-1)", "var(--series-3)", "var(--series-4)", "var(--series-2)", "var(--accent)"];
const PIPE = `M${NODE_X[0]} ${NODE_Y} H${NODE_X[NODE_X.length - 1]}`;

export function PipelineDiagram() {
  const home = copy.home;
  return (
    <svg className="pipeline" viewBox="0 0 520 180" role="img" aria-label={home.heroDiagram}>
      <path className="pipeline-feedback" d={`M${NODE_X[4]} 96 C 400 20, 120 20, ${NODE_X[0]} 96`} />
      <text className="pipeline-feedback-label" x="260" y="40" textAnchor="middle">
        {home.feedback}
      </text>
      <path className="pipeline-track" d={PIPE} />
      <path className="pipeline-flow" d={PIPE} />
      <circle className="pipeline-pulse" r="5">
        <animateMotion dur="4s" repeatCount="indefinite" path={PIPE} />
      </circle>
      {home.pipeline.map((label, i) => (
        <g key={label}>
          <circle className="pipeline-node" cx={NODE_X[i]} cy={NODE_Y} r="18" style={{ stroke: NODE_COLOURS[i] }} />
          <circle cx={NODE_X[i]} cy={NODE_Y} r="6" style={{ fill: NODE_COLOURS[i] }} />
          <text className="pipeline-label" x={NODE_X[i]} y={NODE_Y + 44} textAnchor="middle">
            {label}
          </text>
        </g>
      ))}
    </svg>
  );
}

const ICON_PATHS = {
  frequency: "M4 20V14M9 20V10M14 20V6M19 20V3",
  lead: "M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z",
  failure: "M12 3 3 20h18L12 3ZM12 10v4M12 17v.5",
  restore: "M4 12a8 8 0 1 0 2.3-5.6M4 4v4h4",
} as const;

export function MeasureIcon({ name }: { name: keyof typeof ICON_PATHS }) {
  return (
    <svg className="measure-icon" width="28" height="28" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d={ICON_PATHS[name]} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Illustrative shares of lead time per stage, chosen to show that waiting usually outweighs working. */
const STAGE_SHARE = { coding: 18, waiting: 34, review: 16, merge: 8, deploy: 24 } as const;
const CYCLE_SHARE = 100 - STAGE_SHARE.deploy;

export function StageBar() {
  const home = copy.home;
  return (
    <figure className="stage-figure">
      <div className="stage-spans" aria-hidden="true">
        <span className="stage-span" style={{ width: `${CYCLE_SHARE}%` }}>
          {home.cycleTime}
        </span>
        <span className="stage-span stage-span-lead">{home.leadTime}</span>
      </div>
      <div className="stage-bar" role="img" aria-label={home.flowDiagram}>
        {home.stages.map((stage) => (
          <span key={stage.key} className={`stage-seg stage-seg-${stage.key}`} style={{ flexGrow: STAGE_SHARE[stage.key] }} />
        ))}
      </div>
      <figcaption className="stage-caption">{home.flowIllustrative}</figcaption>
      <ol className="stage-legend">
        {home.stages.map((stage) => (
          <li key={stage.key}>
            <span className={`stage-swatch stage-seg-${stage.key}`} aria-hidden="true" />
            <span>
              <strong>{stage.name}</strong>
              <span className="text-muted"> {stage.detail}</span>
            </span>
          </li>
        ))}
      </ol>
    </figure>
  );
}

/** A clockwise ring with four arrowheads, drawn behind the four steps of a loop. */
function Ring() {
  return (
    <svg className="loop-ring" viewBox="0 0 80 80" aria-hidden="true" focusable="false">
      <circle cx="40" cy="40" r="30" fill="none" stroke="currentColor" strokeWidth="2.5" />
      {[0, 90, 180, 270].map((angle) => (
        <polygon key={angle} points="64,36 76,36 70,45" fill="currentColor" transform={`rotate(${angle} 40 40)`} />
      ))}
    </svg>
  );
}

export function Loop({ tone, title, steps }: { tone: "vicious" | "virtuous"; title: string; steps: readonly string[] }) {
  return (
    <section className={`loop loop-${tone}`} aria-label={title}>
      <h3 className="loop-title">{title}</h3>
      <div className="loop-body">
        <Ring />
        <ol className="loop-steps">
          {steps.map((step, i) => (
            <li key={step} className={`loop-step loop-step-${i + 1}`}>
              <span className="loop-step-number" aria-hidden="true">
                {i + 1}
              </span>
              {step}
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
