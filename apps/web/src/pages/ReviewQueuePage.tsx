import { useMemo, useState } from "react";
import type { QueueEntry, ReviewLane, ReviewQueue } from "@dora-dashboard/core";
import { useReviewQueue } from "../api/hooks";
import { copy } from "../copy";
import { DownloadReportButton } from "../components/DownloadReportButton";
import { FeatureCard } from "../components/FeatureCard";
import { PrQueueCard } from "../components/PrQueueCard";
import { BandLegend, RepoQueueCard } from "../components/RepoQueueCard";
import { ReviewFlag } from "../components/ReviewFlag";
import { StatTile } from "../components/StatTile";
import { EmptyState, ErrorState, Skeleton, SkeletonGrid } from "../components/States";
import { StickyPanel } from "../components/StickyPanel";
import { Toggle } from "../components/Toggle";
import { formatTime } from "../lib/format";
import {
  attentionEntries,
  filterEntries,
  formatWait,
  groupByLane,
  reviewerNames,
  summaryText,
  tilesFor,
  visibleFeatures,
  visibleLanes,
} from "../lib/reviewQueue";
import { useFlagParam, useListParam } from "../lib/urlState";

const text = copy.reviewQueue;

function Tiles({ tiles }: { tiles: ReviewQueue["tiles"] }) {
  const wait = (hours: number | null) => (hours === null ? text.tiles.none : formatWait(hours));
  return (
    <div className="tile-grid">
      <StatTile
        label={text.tiles.waiting}
        value={String(tiles.waiting.count)}
        hint={text.tiles.waitingHint(tiles.waiting.repos, tiles.waiting.heldForRedChecks)}
      />
      <StatTile
        label={text.tiles.pastDay}
        value={String(tiles.pastDay.count)}
        hint={text.tiles.pastDayHint(wait(tiles.pastDay.longestHours))}
      />
      <StatTile
        label={text.tiles.noReviewer}
        value={String(tiles.noReviewer.count)}
        hint={text.tiles.noReviewerHint(wait(tiles.noReviewer.oldestHours))}
      />
      <StatTile
        label={text.tiles.stale}
        value={String(tiles.stale.count)}
        hint={text.tiles.staleHint(wait(tiles.stale.longestHours))}
        tone={tiles.stale.count > 0 ? "danger" : undefined}
      />
      <StatTile label={text.tiles.fastLane} value={String(tiles.fastLane.count)} hint={text.tiles.fastLaneHint} />
      <StatTile label={text.tiles.idle} value={String(tiles.idle.count)} hint={text.tiles.idleHint} />
    </div>
  );
}

/** The queue's filters. The switches and chosen repositories live in the address, so a shared link opens the same view. */
function useQueueView() {
  const [showNames, setShowNames] = useFlagParam("names");
  const [showDrafts, setShowDrafts] = useFlagParam("drafts");
  const [showBots, setShowBots] = useFlagParam("bots");
  const [repoParam, setRepoParam] = useListParam("repos");
  const [waitingOn, setWaitingOn] = useState("");
  const [search, setSearch] = useState("");
  const repoIds = useMemo(() => repoParam.map(Number).filter(Number.isInteger), [repoParam]);
  const toggleRepo = (id: number) =>
    setRepoParam((repoIds.includes(id) ? repoIds.filter((r) => r !== id) : [...repoIds, id]).map(String));
  return {
    showNames,
    setShowNames,
    showDrafts,
    setShowDrafts,
    showBots,
    setShowBots,
    repoIds,
    toggleRepo,
    waitingOn,
    setWaitingOn,
    search,
    setSearch,
  };
}

type QueueView = ReturnType<typeof useQueueView>;
type QueueQuery = ReturnType<typeof useReviewQueue>;

function QueueActions({ queue, visible, showNames }: { queue: QueueQuery; visible: QueueEntry[]; showNames: boolean }) {
  const [copied, setCopied] = useState<"done" | "failed" | null>(null);
  const data = queue.data;

  const copySummary = async () => {
    if (!data) return;
    try {
      await navigator.clipboard.writeText(summaryText(data, visible, showNames));
      setCopied("done");
    } catch {
      setCopied("failed");
    }
  };

  return (
    <div className="queue-actions">
      <button type="button" className="button button-secondary" disabled={!data} onClick={() => void copySummary()}>
        {text.copySummary}
      </button>
      <button type="button" className="button button-secondary" disabled={queue.refreshing} onClick={queue.refresh}>
        {queue.refreshing ? text.refreshing : text.refresh}
      </button>
      {data && <DownloadReportButton subject={text.title} label={text.pdfLabel} />}
      <p role="status" className="queue-status">
        {copied === "done" ? text.copied : copied === "failed" ? text.copyFailed : ""}
      </p>
    </div>
  );
}

function RepoChecks({ repos, view }: { repos: ReviewQueue["repos"]; view: QueueView }) {
  return (
    <fieldset className="queue-repos">
      <legend>{text.controls.repos}</legend>
      {repos.map((repo) => (
        <label key={repo.repoId} className="queue-check">
          <input type="checkbox" checked={view.repoIds.includes(repo.repoId)} onChange={() => view.toggleRepo(repo.repoId)} />
          {repo.repo}
        </label>
      ))}
    </fieldset>
  );
}

function WaitingOnField({ entries, view }: { entries: readonly QueueEntry[]; view: QueueView }) {
  const reviewers = useMemo(() => reviewerNames(entries), [entries]);
  return (
    <div className="field">
      <label htmlFor="queue-waiting-on">{text.controls.waitingOn}</label>
      <select
        id="queue-waiting-on"
        className="input"
        value={view.waitingOn}
        onChange={(event) => view.setWaitingOn(event.target.value)}
      >
        <option value="">{text.controls.anyone}</option>
        {reviewers.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
    </div>
  );
}

const NO_ENTRIES: QueueEntry[] = [];

function QueueControls({ data, view }: { data: ReviewQueue | undefined; view: QueueView }) {
  return (
    <section className="controls-bar queue-controls" aria-label={text.controls.label}>
      {data && data.repos.length > 1 && <RepoChecks repos={data.repos} view={view} />}
      <div className="queue-fields">
        <div className="field">
          <label htmlFor="queue-search">{text.controls.search}</label>
          <input
            id="queue-search"
            className="input"
            type="search"
            value={view.search}
            placeholder={text.controls.searchPlaceholder}
            onChange={(event) => view.setSearch(event.target.value)}
          />
        </div>
        {view.showNames && <WaitingOnField entries={data?.entries ?? NO_ENTRIES} view={view} />}
      </div>
      <div className="queue-toggles">
        <Toggle
          label={text.controls.drafts}
          hint={text.controls.draftsHint}
          checked={view.showDrafts}
          onChange={view.setShowDrafts}
        />
        <Toggle label={text.controls.bots} hint={text.controls.botsHint} checked={view.showBots} onChange={view.setShowBots} />
        <Toggle
          label={text.controls.names}
          hint={text.controls.namesHint}
          checked={view.showNames}
          onChange={view.setShowNames}
        />
      </div>
    </section>
  );
}

function QueueNotices({ data, refreshFailed }: { data: ReviewQueue; refreshFailed: boolean }) {
  return (
    <>
      {data.errors.map((error) => (
        <div key={error.repoId} className="notice notice-warning" role="alert">
          <p className="notice-title">{text.readErrorTitle(error.repo)}</p>
          <p>{text.readErrorBody}</p>
        </div>
      ))}
      {data.warnings?.map((warning) => (
        <div key={warning.repoId} className="notice notice-info" role="status">
          <p className="notice-title">{text.partialTitle(warning.repo)}</p>
          <p>{warning.message}</p>
        </div>
      ))}
      {refreshFailed && (
        <p className="notice notice-warning" role="alert">
          {text.refreshFailed}
        </p>
      )}
    </>
  );
}

function AttentionSection({ urgent, showNames }: { urgent: QueueEntry[]; showNames: boolean }) {
  return (
    <section className="section" aria-labelledby="attention-title">
      <h2 id="attention-title" className="section-title">
        {text.attention.title}
      </h2>
      <p className="section-lede">{text.attention.subtitle}</p>
      {urgent.length === 0 ? (
        <p className="notice notice-info">{text.attention.empty}</p>
      ) : (
        <ol className="attention-list">
          {urgent.map((entry) => (
            <li key={entry.key} className="card attention-row">
              <ReviewFlag entry={entry} />
              <a href={entry.url} target="_blank" rel="noreferrer">
                {entry.repo}#{entry.number} {entry.title}
                <span className="visually-hidden"> {text.card.opensInNewTab}</span>
              </a>
              {showNames && entry.author && <span className="pr-card-meta">{text.card.by(entry.author)}</span>}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function FeaturesSection({ features }: { features: ReturnType<typeof visibleFeatures> }) {
  return (
    <section className="section" aria-labelledby="features-title">
      <h2 id="features-title" className="section-title">
        {text.features.title}
      </h2>
      <p className="section-lede">{text.features.subtitle}</p>
      <ul className="batch-grid feature-list">
        {features.map((feature) => (
          <FeatureCard key={feature.id} feature={feature} />
        ))}
      </ul>
    </section>
  );
}

function ReposSection({ repos }: { repos: ReviewQueue["repos"] }) {
  return (
    <section className="section" aria-labelledby="repos-title">
      <h2 id="repos-title" className="section-title">
        {text.repos.title}
      </h2>
      <p className="section-lede">{text.repos.subtitle}</p>
      <BandLegend />
      <ul className="batch-grid">
        {repos.map((summary) => (
          <RepoQueueCard key={summary.repoId} summary={summary} />
        ))}
      </ul>
    </section>
  );
}

function Lane({ lane, entries, showNames }: { lane: ReviewLane; entries: QueueEntry[]; showNames: boolean }) {
  return (
    <section className="queue-lane" aria-labelledby={`lane-${lane}`}>
      <div className="queue-lane-head">
        <h3 id={`lane-${lane}`} className="queue-lane-title">
          {text.lanes[lane].title} <span className="queue-lane-count">{entries.length}</span>
        </h3>
        <p className="queue-lane-hint">{text.lanes[lane].hint}</p>
      </div>
      {entries.length === 0 ? (
        <p className="queue-lane-empty">{text.lanes.empty}</p>
      ) : (
        <ul className="pr-list">
          {entries.map((entry) => (
            <PrQueueCard key={entry.key} entry={entry} showNames={showNames} />
          ))}
        </ul>
      )}
    </section>
  );
}

function QueueContent({ data, visible, view }: { data: ReviewQueue; visible: QueueEntry[]; view: QueueView }) {
  const { showNames, showDrafts, repoIds } = view;
  const tiles = useMemo(() => tilesFor(visible), [visible]);
  const lanes = useMemo(() => visibleLanes(showDrafts), [showDrafts]);
  const grouped = useMemo(() => groupByLane(visible, lanes), [visible, lanes]);
  const urgent = useMemo(() => attentionEntries(data, visible), [data, visible]);
  const features = useMemo(() => visibleFeatures(data.features, visible), [data, visible]);
  const keptRepos = data.repos.filter((r) => !repoIds.length || repoIds.includes(r.repoId));

  if (data.entries.length === 0) return <EmptyState title={text.empty}>{text.emptyBody}</EmptyState>;
  return (
    <>
      <Tiles tiles={tiles} />
      <AttentionSection urgent={urgent} showNames={showNames} />
      {features.length > 0 && <FeaturesSection features={features} />}
      <ReposSection repos={keptRepos} />
      {visible.length === 0 ? (
        <EmptyState title={text.noMatches} />
      ) : (
        <div className="queue-board" role="region" aria-label={text.lanes.boardLabel} tabIndex={0}>
          {lanes.map((lane) => (
            <Lane key={lane} lane={lane} entries={grouped[lane]} showNames={showNames} />
          ))}
        </div>
      )}
    </>
  );
}

function QueueBody({ queue, visible, view }: { queue: QueueQuery; visible: QueueEntry[]; view: QueueView }) {
  if (queue.isPending) {
    return (
      <>
        <SkeletonGrid count={6} height={96} label={text.loading} />
        <Skeleton height={160} label={text.loading} />
      </>
    );
  }
  if (queue.isError && !queue.data) return <ErrorState error={queue.error} onRetry={() => void queue.refetch()} />;
  if (!queue.data) return null;
  return (
    <>
      <QueueNotices data={queue.data} refreshFailed={queue.refreshFailed} />
      <QueueContent data={queue.data} visible={visible} view={view} />
    </>
  );
}

export function ReviewQueuePage() {
  const view = useQueueView();
  const { showNames, waitingOn, search, showDrafts, showBots, repoIds } = view;
  const queue = useReviewQueue({ names: showNames });
  const data = queue.data;
  const visible = useMemo(
    () =>
      data ? filterEntries(data.entries, { waitingOn: showNames ? waitingOn : "", search, showDrafts, showBots, repoIds }) : [],
    [data, waitingOn, search, showDrafts, showBots, showNames, repoIds],
  );

  return (
    <div className="page">
      <StickyPanel>
        <header className="page-header page-header-row">
          <div className="page-header">
            <h1>{text.title}</h1>
            <p className="lede">{text.lede}</p>
            {data && <p className="chart-subtitle">{text.updated(formatTime(data.fetchedAt))}</p>}
          </div>
          <QueueActions queue={queue} visible={visible} showNames={showNames} />
        </header>
        <QueueControls data={data} view={view} />
      </StickyPanel>

      <QueueBody queue={queue} visible={visible} view={view} />
    </div>
  );
}
