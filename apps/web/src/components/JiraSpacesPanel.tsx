import { useId, useState } from "react";
import { Link } from "react-router";
import type { LinkedSpace, SpaceDescription, TrackerSite, TrackerSpaceSummary, TrackerStatus } from "@dora-dashboard/core";
import {
  useCrawlSpace,
  useDisconnectJira,
  useHealth,
  useJira,
  useJiraSpaceDetail,
  useJiraSpaces,
  useLinkSpaces,
  useLinkedSpaces,
} from "../api/hooks";
import { errorText } from "../api/client";
import { copy } from "../copy";
import { ConnectButton } from "./JiraOutcomeNotice";
import { ErrorState } from "./States";
import { formatDateTime, formatNumber } from "../lib/format";
import {
  MAX_LINKED_SPACES,
  columnsWithStatuses,
  filterSpaces,
  groupStatusesByCategory,
  isCrawlConflict,
  isJiraUnauthorised,
  linkedKeysForSite,
  toggleKey,
} from "../lib/jira";

function LapsedNotice({ reason }: { reason: "idle" | "refused" | "expired" }) {
  const text = copy.jira.lapsed[reason];
  return (
    <div className="notice notice-warning jira-connect" role="status" data-lapsed={reason}>
      <p className="notice-title">{text.title}</p>
      <p>{text.body}</p>
      <ConnectButton label={copy.jira.connectAgain} />
    </div>
  );
}

function ReconnectNotice() {
  return (
    <div className="notice notice-warning" role="alert">
      <p className="notice-title">{copy.jira.unauthorisedTitle}</p>
      <p>{copy.jira.unauthorisedBody}</p>
      <ConnectButton label={copy.jira.connectAgain} />
    </div>
  );
}

/** An error from Jira, or the way back in when the grant was refused. */
function JiraError({ error }: { error: unknown }) {
  if (isJiraUnauthorised(error)) return <ReconnectNotice />;
  return (
    <p className="notice notice-error" role="alert">
      {errorText(error)}
    </p>
  );
}

function StatusChips({ statuses }: { statuses: readonly TrackerStatus[] }) {
  return (
    <ul className="jira-chips">
      {statuses.map((status) => (
        <li key={status.id} className="jira-chip">
          {status.name}
        </li>
      ))}
    </ul>
  );
}

function BoardColumns({ detail }: { detail: SpaceDescription }) {
  if (detail.board === "forbidden") {
    return (
      <div className="notice notice-warning" role="status">
        <p className="notice-title">{copy.jira.boardForbiddenTitle}</p>
        <p>{copy.jira.boardForbidden}</p>
      </div>
    );
  }
  if (detail.columns.length === 0) return <p className="field-hint">{copy.jira.noBoard}</p>;
  return (
    <ol className="jira-columns">
      {columnsWithStatuses(detail.columns, detail.statuses).map((column, index) => (
        <li key={`${index}-${column.name}`} className="jira-column">
          <span className="jira-column-name">{column.name}</span>
          {column.statuses.length === 0 ? (
            <span className="text-muted">{copy.jira.noColumnStatuses}</span>
          ) : (
            <StatusChips statuses={column.statuses} />
          )}
        </li>
      ))}
    </ol>
  );
}

function StatusCategories({ statuses }: { statuses: readonly TrackerStatus[] }) {
  if (statuses.length === 0) return <p className="field-hint">{copy.jira.noStatuses}</p>;
  return (
    <dl className="jira-categories">
      {groupStatusesByCategory(statuses).map((group) => (
        <div key={group.category} className={`jira-category jira-category-${group.category}`}>
          <dt>{copy.jira.categories[group.category]}</dt>
          <dd>
            <StatusChips statuses={group.statuses} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

function SpaceFlowDetail({ detail }: { detail: ReturnType<typeof useJiraSpaceDetail> }) {
  return (
    <>
      {detail.isPending && <p role="status">{copy.jira.loadingFlow}</p>}
      {detail.isError && <JiraError error={detail.error} />}
      {detail.data && (
        <div className="jira-flow-body">
          <h5 className="jira-flow-heading">{copy.jira.columnsTitle}</h5>
          <BoardColumns detail={detail.data} />
          <h5 className="jira-flow-heading">{copy.jira.categoriesTitle}</h5>
          <StatusCategories statuses={detail.data.statuses} />
        </div>
      )}
    </>
  );
}

/** A space's statuses grouped by category and its board columns, so someone can judge it before linking. */
function SpaceFlow({ siteId, spaceKey, name }: { siteId: string; spaceKey: string; name: string }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const detail = useJiraSpaceDetail(siteId, spaceKey, open);
  return (
    <div className="jira-flow">
      <button
        type="button"
        className="button button-ghost"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={copy.jira.flowToggleLabel(name)}
        onClick={() => setOpen((value) => !value)}
      >
        {copy.jira.flowToggle}
      </button>
      <div id={panelId} hidden={!open}>
        {open && <SpaceFlowDetail detail={detail} />}
      </div>
    </div>
  );
}

interface SpaceChoiceProps {
  siteId: string;
  space: TrackerSpaceSummary;
  checked: boolean;
  atLimit: boolean;
  onToggle: (checked: boolean) => void;
}

function SpaceChoice({ siteId, space, checked, atLimit, onToggle }: SpaceChoiceProps) {
  return (
    <li className="jira-space">
      <label className="checkbox">
        <input
          type="checkbox"
          checked={checked}
          disabled={!checked && atLimit}
          onChange={(event) => onToggle(event.target.checked)}
        />
        <span>
          {space.name} <span className="mono text-muted">{space.key}</span>
        </span>
      </label>
      {checked && <SpaceFlow siteId={siteId} spaceKey={space.key} name={space.name} />}
    </li>
  );
}

function SpaceSearch({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const searchId = useId();
  return (
    <div className="field">
      <label htmlFor={searchId}>{copy.jira.searchLabel}</label>
      <input
        id={searchId}
        type="search"
        className="input"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoComplete="off"
        spellCheck={false}
      />
    </div>
  );
}

interface SpaceChoicesProps {
  siteId: string;
  spaces: TrackerSpaceSummary[];
  search: string;
  selected: string[];
  onChange: (selected: string[]) => void;
}

/** A site's spaces that match the search, capped at `MAX_LINKED_SPACES` ticked. */
function SpaceChoices({ siteId, spaces, search, selected, onChange }: SpaceChoicesProps) {
  const visible = filterSpaces(spaces, search);
  const atLimit = selected.length >= MAX_LINKED_SPACES;
  return (
    <>
      <p className="field-hint" role="status">
        {copy.jira.showing(visible.length, spaces.length)}. {copy.jira.selectedCount(selected.length)}.
        {atLimit ? ` ${copy.jira.limitReached(MAX_LINKED_SPACES)}` : ""}
      </p>
      {visible.length === 0 && <p>{copy.jira.noMatches}</p>}
      <ul className="jira-space-list">
        {visible.map((space) => (
          <SpaceChoice
            key={space.key}
            siteId={siteId}
            space={space}
            checked={selected.includes(space.key)}
            atLimit={atLimit}
            onToggle={(checked) => onChange(toggleKey(selected, space.key, checked))}
          />
        ))}
      </ul>
    </>
  );
}

function SpacesStatus({ spaces }: { spaces: ReturnType<typeof useJiraSpaces> }) {
  return (
    <>
      {spaces.isPending && <p role="status">{copy.jira.loadingSpaces}</p>}
      {spaces.isError && <JiraError error={spaces.error} />}
      {spaces.isSuccess && spaces.data.length === 0 && <p>{copy.jira.noSpaces}</p>}
    </>
  );
}

interface SaveLinksProps {
  link: ReturnType<typeof useLinkSpaces>;
  /** True once the last save succeeded and nothing has been ticked or unticked since. */
  saved: boolean;
  ready: boolean;
  onSave: () => void;
}

function SaveLinks({ link, saved, ready, onSave }: SaveLinksProps) {
  return (
    <>
      {link.isError && <JiraError error={link.error} />}
      {saved && (
        <p className="notice notice-info" role="status">
          {copy.jira.linksSaved}
        </p>
      )}
      <div className="form-actions">
        <button type="button" className="button button-primary" disabled={link.isPending || !ready} onClick={onSave}>
          {link.isPending ? copy.jira.savingLinks : copy.jira.saveLinks}
        </button>
      </div>
    </>
  );
}

interface SpacePickerProps {
  repoId: number;
  site: TrackerSite;
  linked: LinkedSpace[];
}

function SpacePicker({ repoId, site, linked }: SpacePickerProps) {
  const spaces = useJiraSpaces(site.id);
  const link = useLinkSpaces(repoId);
  // Held here rather than in SpaceChoices, so a search survives the list unmounting while a refused grant or no spaces are shown.
  const [search, setSearch] = useState("");
  const [edit, setEdit] = useState<string[] | null>(null);

  const selected = edit ?? linkedKeysForSite(linked, site.id);
  const all: TrackerSpaceSummary[] = spaces.data ?? [];

  if (isJiraUnauthorised(spaces.error) || isJiraUnauthorised(link.error)) return <ReconnectNotice />;

  const save = () => link.mutate({ siteId: site.id, keys: selected }, { onSuccess: () => setEdit(null) });

  return (
    <fieldset className="checkbox-group jira-picker">
      <legend>{copy.jira.spacesLegend}</legend>
      <p className="field-hint">{copy.jira.spacesHint(MAX_LINKED_SPACES)}</p>
      <SpacesStatus spaces={spaces} />
      {all.length > 0 && (
        <>
          <SpaceSearch value={search} onChange={setSearch} />
          <SpaceChoices siteId={site.id} spaces={all} search={search} selected={selected} onChange={setEdit} />
        </>
      )}
      <SaveLinks link={link} saved={link.isSuccess && edit === null} ready={spaces.isSuccess} onSave={save} />
    </fieldset>
  );
}

function LinkedSpaceItem({ space, onCrawl, busy }: { space: LinkedSpace; onCrawl: (full: boolean) => void; busy: boolean }) {
  const crawling = space.crawlStatus === "crawling";
  const disabled = crawling || busy;
  return (
    <li className="jira-linked-item">
      <div className="jira-linked-head">
        <strong>
          <Link to={`/spaces/${space.id}`}>{space.name}</Link>
        </strong>{" "}
        <span className="mono text-muted">{space.key}</span>
      </div>
      <dl className="repo-facts">
        <div>
          <dt>{copy.jira.siteHeading}</dt>
          <dd className="mono">{space.siteUrl}</dd>
        </div>
        <div>
          <dt>{copy.jira.workItems}</dt>
          <dd>{formatNumber(space.workItemCount, 0)}</dd>
        </div>
        <div>
          <dt>{copy.jira.lastCrawled}</dt>
          <dd>{space.lastCrawledAt ? formatDateTime(space.lastCrawledAt) : copy.jira.neverCrawled}</dd>
        </div>
      </dl>
      <div className="repo-status" role="status" aria-live="polite">
        <span className={`status-pill status-pill-${space.crawlStatus}`}>
          {crawling && <span className="spinner" aria-hidden="true" />}
          {copy.jira.status[space.crawlStatus]}
        </span>
        {crawling && <span className="crawl-progress">{space.crawlProgress ?? copy.jira.crawlingFallback}</span>}
      </div>
      {space.crawlStatus === "failed" && space.crawlError && (
        <p className="notice notice-error" role="alert">
          {space.crawlError}
        </p>
      )}
      <div className="form-actions">
        <button
          type="button"
          className="button button-secondary"
          disabled={disabled}
          aria-label={copy.jira.recrawlLabel(space.name)}
          onClick={() => onCrawl(false)}
        >
          {copy.jira.recrawl}
        </button>
        <button
          type="button"
          className="button button-secondary"
          disabled={disabled}
          aria-label={copy.jira.fullRecrawlLabel(space.name)}
          onClick={() => onCrawl(true)}
        >
          {copy.jira.fullRecrawl}
        </button>
      </div>
      <SpaceFlow siteId={space.siteId} spaceKey={space.key} name={space.name} />
    </li>
  );
}

function LinkedSpaces({ repoId, linked }: { repoId: number; linked: ReturnType<typeof useLinkedSpaces> }) {
  const crawl = useCrawlSpace(repoId);
  if (linked.isPending) return <p role="status">{copy.jira.loadingLinked}</p>;
  if (isJiraUnauthorised(linked.error) || isJiraUnauthorised(crawl.error)) return <ReconnectNotice />;
  if (linked.isError)
    return (
      <p className="notice notice-error" role="alert">
        {errorText(linked.error)}
      </p>
    );
  return (
    <section aria-labelledby={`jira-linked-${repoId}`}>
      <h4 id={`jira-linked-${repoId}`} className="jira-subtitle">
        {copy.jira.linkedTitle}
      </h4>
      {linked.data.length === 0 && <p className="field-hint">{copy.jira.noLinked}</p>}
      <ul className="jira-linked">
        {linked.data.map((space) => (
          <LinkedSpaceItem
            key={space.id}
            space={space}
            busy={crawl.isPending}
            onCrawl={(full) => crawl.mutate({ id: space.id, full })}
          />
        ))}
      </ul>
      {isCrawlConflict(crawl.error) && (
        <p className="notice notice-info" role="status">
          {copy.jira.crawlAlreadyRunning}
        </p>
      )}
      {crawl.isError && !isJiraUnauthorised(crawl.error) && !isCrawlConflict(crawl.error) && (
        <p className="notice notice-error" role="alert">
          {errorText(crawl.error)}
        </p>
      )}
    </section>
  );
}

function JiraConnected({ repoId, sites }: { repoId: number; sites: TrackerSite[] }) {
  const linked = useLinkedSpaces(repoId, true);
  const disconnect = useDisconnectJira();
  const [chosen, setChosen] = useState<string | null>(null);
  const siteSelectId = useId();

  const linkedSite = linked.data?.[0]?.siteId;
  const siteId = chosen ?? (sites.length === 1 ? sites[0]!.id : sites.some((s) => s.id === linkedSite) ? linkedSite! : "");
  const site = sites.find((s) => s.id === siteId);

  return (
    <>
      {sites.length === 0 ? (
        <p>{copy.jira.noSites}</p>
      ) : (
        <div className="field">
          <label htmlFor={siteSelectId}>{copy.jira.siteLabel}</label>
          <select id={siteSelectId} className="input" value={siteId} onChange={(event) => setChosen(event.target.value)}>
            {siteId === "" && <option value="">{copy.jira.sitePlaceholder}</option>}
            {sites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
      )}
      {site && <SpacePicker key={site.id} repoId={repoId} site={site} linked={linked.data ?? []} />}
      <LinkedSpaces repoId={repoId} linked={linked} />
      {disconnect.isError && (
        <p className="notice notice-error" role="alert">
          {errorText(disconnect.error)}
        </p>
      )}
      <div className="form-actions">
        <button
          type="button"
          className="button button-danger"
          disabled={disconnect.isPending}
          onClick={() => disconnect.mutate()}
        >
          {disconnect.isPending ? copy.jira.disconnecting : copy.jira.disconnect}
        </button>
      </div>
    </>
  );
}

/**
 * Links Jira spaces to a repository so their issues can be joined to its pull requests. It renders nothing
 * when the server says Jira is off, and an error with a retry when the server could not be asked.
 */
export function JiraSpacesPanel({ repoId }: { repoId: number }) {
  const health = useHealth();
  const enabled = health.data?.jira === true;
  const jira = useJira(enabled);
  const titleId = useId();

  if (health.isError) return <ErrorState error={health.error} onRetry={() => void health.refetch()} />;
  if (!enabled) return null;

  let body;
  if (jira.isPending) body = <p role="status">{copy.jira.loading}</p>;
  else if (jira.isError) {
    body = isJiraUnauthorised(jira.error) ? (
      <ReconnectNotice />
    ) : (
      <ErrorState error={jira.error} onRetry={() => void jira.refetch()} />
    );
  } else if (!jira.data.connected && jira.data.lapsed) {
    body = <LapsedNotice reason={jira.data.lapsed} />;
  } else if (!jira.data.connected) {
    body = (
      <div className="jira-connect">
        <p>{copy.jira.notConnectedTitle}</p>
        <ConnectButton label={copy.jira.connect} />
      </div>
    );
  } else body = <JiraConnected repoId={repoId} sites={jira.data.sites} />;

  return (
    <section className="configure-panel jira-panel" aria-labelledby={titleId}>
      <h3 id={titleId} className="configure-title">
        {copy.jira.title}
      </h3>
      <p className="field-hint">{copy.jira.lede}</p>
      {body}
    </section>
  );
}
