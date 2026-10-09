import type { CSSProperties } from "react";
import type { Band } from "@dora-dashboard/core";
import { Link } from "react-router";
import { copy } from "../copy";
import { BandLabel } from "../components/BandLabel";
import { DownloadReportButton } from "../components/DownloadReportButton";
import { ExternalLink } from "../components/ExternalLink";
import { Loop, MeasureIcon, PipelineDiagram, StageBar } from "../components/HomeDiagrams";

const BANDS: Band[] = ["elite", "high", "medium", "low"];
const GROUPS = ["throughput", "stability"] as const;

interface OutsideLink {
  label: string;
  href: string;
}

function onceEach(links: OutsideLink[]): OutsideLink[] {
  return links.filter((link, i) => links.findIndex((other) => other.href === link.href) === i);
}

/**
 * Every outside link on the page in reading order, each address once, for the list printed at the end of the
 * PDF. The page test fails when a link is added to the page and not here.
 */
const OUTSIDE_LINKS = onceEach([
  { label: copy.home.bandsSource, href: copy.home.bandsSourceHref },
  copy.dora.explain.source,
  ...copy.dora.explain.moveUp.links.map((key) => ({
    label: copy.dora.explain.practices[key].name,
    href: copy.dora.explain.practices[key].href,
  })),
  copy.dora.explain.system,
  { label: copy.home.beckSource, href: copy.home.reading[0].href },
  ...copy.home.reading.map((r) => ({ label: r.title, href: r.href })),
]);

function Hero() {
  const home = copy.home;
  return (
    <section className="home-hero" aria-labelledby="home-title">
      <div className="home-hero-text">
        <p className="home-eyebrow">{home.eyebrow}</p>
        <h1 id="home-title">{home.title}</h1>
        <p className="home-lede">{home.lede}</p>
        <div className="home-actions">
          <Link to="/repos" className="button button-primary">
            {home.toRepos}
          </Link>
          <a href="#four-keys" className="button button-secondary">
            {home.toKeys}
          </a>
          <DownloadReportButton subject={home.pdfSubject} label={home.pdfLabel} />
        </div>
      </div>
      <div className="home-hero-art">
        <PipelineDiagram />
      </div>
    </section>
  );
}

function Principles() {
  const home = copy.home;
  return (
    <section className="home-section" aria-labelledby="principles-title">
      <h2 id="principles-title" className="home-h2">
        {home.principlesTitle}
      </h2>
      <ol className="principle-grid">
        {home.principles.map((p, i) => (
          <li key={p.title} className="principle">
            <span className="principle-number" aria-hidden="true">
              {String(i + 1).padStart(2, "0")}
            </span>
            <h3>{p.title}</h3>
            <p>{p.body}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

type Measure = (typeof copy.home.measures)[number];

function MeasureCard({ measure }: { measure: Measure }) {
  const labels = copy.home.measureLabels;
  return (
    <article className={`measure-card measure-${measure.group}`}>
      <header className="measure-head">
        <MeasureIcon name={measure.key} />
        <div>
          <h4>{measure.name}</h4>
          <p className="measure-question">{measure.question}</p>
        </div>
      </header>
      <dl className="measure-facts">
        <dt>{labels.measures}</dt>
        <dd>{measure.measures}</dd>
        <dt>{labels.why}</dt>
        <dd>{measure.why}</dd>
        <dt>{labels.improve}</dt>
        <dd>{measure.improve}</dd>
      </dl>
    </article>
  );
}

function FourKeys() {
  const home = copy.home;
  return (
    <section id="four-keys" className="home-section" aria-labelledby="four-keys-title">
      <p className="home-eyebrow">{home.doraEyebrow}</p>
      <h2 id="four-keys-title" className="home-h2">
        {home.doraTitle}
      </h2>
      <p className="home-section-lede">{home.doraLede}</p>
      <div className="measure-groups">
        {GROUPS.map((group) => (
          <section key={group} className={`measure-group measure-${group}`} aria-labelledby={`group-${group}`}>
            <h3 id={`group-${group}`}>{home.groups[group].title}</h3>
            <p className="text-muted">{home.groups[group].body}</p>
            {home.measures
              .filter((m) => m.group === group)
              .map((m) => (
                <MeasureCard key={m.key} measure={m} />
              ))}
          </section>
        ))}
      </div>
    </section>
  );
}

function Flow() {
  const home = copy.home;
  return (
    <section className="home-section" aria-labelledby="flow-title">
      <h2 id="flow-title" className="home-h2">
        {home.flowTitle}
      </h2>
      <p className="home-section-lede">{home.flowLede}</p>
      <StageBar />
      <p className="home-callout">{home.flowInsight}</p>
    </section>
  );
}

function Bands() {
  const home = copy.home;
  return (
    <section className="home-section" aria-labelledby="bands-title">
      <h2 id="bands-title" className="home-h2">
        {home.bandsTitle}
      </h2>
      <p className="home-section-lede">{home.bandsLede}</p>
      <p className="home-section-lede">
        {home.bandsProfile} <ExternalLink href={home.bandsSourceHref}>{home.bandsSource}</ExternalLink>
      </p>
      <div className="table-scroll">
        <table className="data-table band-table">
          <caption className="visually-hidden">{home.bandsCaption}</caption>
          <thead>
            <tr>
              <th scope="col">{home.bandsMeasure}</th>
              {BANDS.map((band) => (
                <th key={band} scope="col">
                  <BandLabel band={band} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {home.bandRows.map((row) => (
              <tr key={row.name}>
                <th scope="row">{row.name}</th>
                {BANDS.map((band) => (
                  <td key={band}>{row[band]}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <BandMeanings />
      <MoveUp />
    </section>
  );
}

const MEASURES = ["deploymentFrequency", "leadTime", "changeFailure", "timeToRestore"] as const;

function BandMeanings() {
  const text = copy.dora.explain;
  return (
    <>
      <h3 className="home-h3">{text.meaningTitle}</h3>
      <p className="home-section-lede">
        {text.meaningLede} <ExternalLink href={text.source.href}>{text.source.label}</ExternalLink>
      </p>
      <ul className="practice-grid">
        {MEASURES.map((measure) => (
          <li key={measure} className="practice">
            <h4>{copy.dora[measure]}</h4>
            <dl className="band-meanings">
              {BANDS.map((band) => (
                <div key={band}>
                  <dt>
                    <BandLabel band={band} />
                  </dt>
                  <dd>{text.meaning[measure][band]}</dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ul>
    </>
  );
}

function MoveUp() {
  const text = copy.dora.explain;
  return (
    <>
      <h3 className="home-h3">{text.moveUp.title}</h3>
      <p className="home-section-lede">{text.moveUp.body}</p>
      <p className="home-section-lede">
        {text.moveUp.linksLead}{" "}
        {text.moveUp.links.map((key, i) => (
          <span key={key}>
            {i > 0 && (i === text.moveUp.links.length - 1 ? ` ${copy.common.and} ` : ", ")}
            <ExternalLink href={text.practices[key].href}>{text.practices[key].name}</ExternalLink>
          </span>
        ))}
        .
      </p>
      <blockquote className="dora-explain-quote home-quote">
        <p>{text.system.quote}</p>
        <ExternalLink href={text.system.href}>{text.system.label}</ExternalLink>
      </blockquote>
    </>
  );
}

function JiraDelivery() {
  const jira = copy.home.jira;
  return (
    <section id="jira-delivery" className="home-section" aria-labelledby="jira-delivery-title">
      <p className="home-eyebrow">{jira.eyebrow}</p>
      <h2 id="jira-delivery-title" className="home-h2">
        {jira.title}
      </h2>
      <p className="home-section-lede">{jira.lede}</p>
      <ul className="practice-grid">
        {jira.measures.map((m) => (
          <li key={m.name} className="practice">
            <h3>{m.name}</h3>
            <p>{m.reveals}</p>
          </li>
        ))}
      </ul>
      <p className="home-callout">{jira.people}</p>
    </section>
  );
}

function BeckRules() {
  const home = copy.home;
  return (
    <section id="simple-design" className="home-section" aria-labelledby="beck-title">
      <p className="home-eyebrow">{home.beckEyebrow}</p>
      <h2 id="beck-title" className="home-h2">
        {home.beckTitle}
      </h2>
      <p className="home-section-lede">{home.beckLede}</p>
      <ol className="rule-list">
        {home.rules.map((rule, i) => (
          <li key={rule.name} className="rule" style={{ "--priority": 1 - i * 0.18 } as CSSProperties}>
            <span className="rule-number" aria-hidden="true">
              {i + 1}
            </span>
            <div className="rule-body">
              <h3>{rule.name}</h3>
              <span className="rule-priority" aria-hidden="true" />
              <p>{rule.body}</p>
              <p className="rule-measured">
                <span className="rule-measured-label">{home.beckMeasured}</span>
                {rule.measured}
              </p>
            </div>
          </li>
        ))}
      </ol>
      <p>
        <ExternalLink href={home.reading[0].href}>{home.beckSource}</ExternalLink>
      </p>
    </section>
  );
}

function Loops() {
  const home = copy.home;
  return (
    <section className="home-section" aria-labelledby="loops-title">
      <h2 id="loops-title" className="home-h2">
        {home.loopTitle}
      </h2>
      <p className="home-section-lede">{home.loopLede}</p>
      <div className="loop-grid">
        <Loop tone="vicious" title={home.loops.vicious.title} steps={home.loops.vicious.steps} />
        <Loop tone="virtuous" title={home.loops.virtuous.title} steps={home.loops.virtuous.steps} />
      </div>
    </section>
  );
}

function Practices() {
  const home = copy.home;
  return (
    <section className="home-section" aria-labelledby="practice-title">
      <h2 id="practice-title" className="home-h2">
        {home.practiceTitle}
      </h2>
      <ul className="practice-grid">
        {home.practices.map((p) => (
          <li key={p.title} className="practice">
            <h3>{p.title}</h3>
            <p>{p.body}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Reading() {
  const home = copy.home;
  return (
    <section className="home-section" aria-labelledby="reading-title">
      <h2 id="reading-title" className="home-h2">
        {home.readingTitle}
      </h2>
      <ul className="reading-list">
        {home.reading.map((r) => (
          <li key={r.href}>
            <ExternalLink href={r.href}>{r.title}</ExternalLink>
            <p className="text-muted">{r.by}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Closing() {
  const home = copy.home;
  return (
    <section className="home-cta" aria-labelledby="cta-title">
      <h2 id="cta-title" className="home-h2">
        {home.ctaTitle}
      </h2>
      <p>{home.ctaBody}</p>
      <Link to="/repos" className="button button-primary">
        {home.toRepos}
      </Link>
    </section>
  );
}

/** Printed only, so a reader of the PDF on paper can still follow every link. */
function PrintedLinks() {
  const home = copy.home;
  return (
    <section className="home-section home-links" aria-labelledby="links-title">
      <h2 id="links-title" className="home-h2">
        {home.linksTitle}
      </h2>
      <p className="home-section-lede">{home.linksLede}</p>
      <ol className="home-link-list">
        {OUTSIDE_LINKS.map((link) => (
          <li key={link.href}>
            <a href={link.href}>
              <span className="home-link-label">{link.label}</span>
              <span className="home-link-href">{link.href}</span>
            </a>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** The landing page. It explains the theory behind every figure the dashboard shows. */
export function HomePage() {
  return (
    <div className="page home">
      <Hero />
      <Principles />
      <FourKeys />
      <Flow />
      <Bands />
      <JiraDelivery />
      <BeckRules />
      <Loops />
      <Practices />
      <Reading />
      <Closing />
      <PrintedLinks />
    </div>
  );
}
