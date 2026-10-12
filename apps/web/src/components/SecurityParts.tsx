import type { ReactNode } from "react";
import type { Severity } from "@dora-dashboard/core";
import { copy } from "../copy";
import { effortLabel, severityLabel, type Effort } from "../lib/security";

/** A titled section of the security report, with a lede saying what it shows. */
export function SecurityBlock({ id, title, lede, children }: { id: string; title: string; lede?: string; children: ReactNode }) {
  const titleId = `${id}-title`;
  return (
    <section id={id} aria-labelledby={titleId} className="section">
      <h2 id={titleId} className="section-title">
        {title}
      </h2>
      {lede && <p className="section-lede">{lede}</p>}
      {children}
    </section>
  );
}

/** A small label such as an effort or a severity. It is always words, so colour is never the only signal. */
export function Tag({ children, tone }: { children: ReactNode; tone?: "danger" | "accent" }) {
  return <span className={`tag${tone ? ` tag-${tone}` : ""}`}>{children}</span>;
}

export function EffortTag({ effort }: { effort: Effort }) {
  return <Tag>{effortLabel(effort)}</Tag>;
}

/** A swatch beside the severity word, in the severity's own colour, so the word still carries the meaning. */
export function SeverityTag({ severity, colour }: { severity: Severity; colour: string }) {
  return (
    <span className="severity-tag">
      <span className="legend-swatch legend-swatch-square" style={{ background: colour }} aria-hidden="true" />
      {severityLabel(severity)}
    </span>
  );
}

export function LikelyExploitedTag() {
  return (
    <span title={copy.security.likelyExploitedTitle}>
      <Tag tone="danger">{copy.security.tags.likelyExploited}</Tag>
    </span>
  );
}
