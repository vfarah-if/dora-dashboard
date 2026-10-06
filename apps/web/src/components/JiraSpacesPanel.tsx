import { useId, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router";
import type { TrackerSite, TrackerSpaceSummary } from "@dora-dashboard/core";
import {
  useCrawlSpace,
  useDisconnectJira,
  useHealth,
  useJira,
  useJiraSpaceDetail,
  useJiraSpaces,
  useLinkSpaces,
  useLinkedSpaces,
  type LinkedSpace,
} from "../api/hooks";
import { errorText } from "../api/client";
import { copy } from "../copy";
import { formatDateTime, formatNumber } from "../lib/format";
import {
  MAX_LINKED_SPACES,
  columnsWithStatuses,
  filterSpaces,
  groupStatusesByCategory,
  isCrawlConflict,
  isJiraUnauthorised,
  jiraConnectUrl,
  linkedKeysForSite,
  toggleKey,
} from "../lib/jira";

const ERROR_PARAM = "jira";

function ConnectButton({ label, primary = true }: { label: string; primary?: boolean }) {
  const location = useLocation();
  const connect = () => window.location.assign(jiraConnectUrl(`${location.pathname}${location.search}`));
  return (
    <button type="button" className={`button ${primary ? "button-primary" : "button-secondary"}`} onClick={connect}>
      {label}
    </button>
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

function ConnectFailedNotice({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div className="notice notice-error" role="alert">
      <p className="notice-title">{copy.jira.connectFailedTitle}</p>
      <p>{copy.jira.connectFailedBody}</p>
      <button type="button" className="button button-ghost" onClick={onDismiss}>
        {copy.jira.dismiss}
      </button>
    </div>
  );
}

/** A space's statuses grouped by category and its board columns, so someone can judge it before linking. */
function SpaceFlow({ siteId, spaceKey, name }: { siteId: string; spaceKey: string; name: string }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const detail = useJiraSpaceDetail(siteId, spaceKey, open);
  const data = detail.data;
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
        {open && detail.isPending && <p role="status">{copy.jira.loadingFlow}</p>}
        {open &&
          detail.isError &&
          (isJiraUnauthorised(detail.error) ? (
            <ReconnectNotice />
          ) : (
            <p className="notice notice-error" role="alert">
              {errorText(detail.error)}
            </p>
          ))}
        {open && data && (
          <div className="jira-flow-body">
            <h5 className="jira-flow-heading">{copy.jira.columnsTitle}</h5>
            {data.columns.length === 0 ? (
              <p className="field-hint">{copy.jira.noBoard}</p>
            ) : (
              <ol className="jira-columns">
                {columnsWithStatuses(data.columns, data.statuses).map((column, index) => (
                  <li key={`${index}-${column.name}`} className="jira-column">
                    <span className="jira-column-name">{column.name}</span>
                    {column.statuses.length === 0 ? (
                      <span className="text-muted">{copy.jira.noColumnStatuses}</span>
                    ) : (
                      <ul className="jira-chips">
                        {column.statuses.map((status) => (
                          <li key={status.id} className="jira-chip">
                            {status.name}
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ol>
            )}
            <h5 className="jira-flow-heading">{copy.jira.categoriesTitle}</h5>
            {data.statuses.length === 0 ? (
              <p className="field-hint">{copy.jira.noStatuses}</p>
            ) : (
              <dl className="jira-categories">
                {groupStatusesByCategory(data.statuses).map((group) => (
                  <div key={group.category} className={`jira-category jira-category-${group.category}`}>
                    <dt>{copy.jira.categories[group.category]}</dt>
                    <dd>
                      <ul className="jira-chips">
                        {group.statuses.map((status) => (
                          <li key={status.id} className="jira-chip">
                            {status.name}
                          </li>
                        ))}
                      </ul>
                    </dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
        )}
      </div>
    </div>
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
  const [search, setSearch] = useState("");
  const [edit, setEdit] = useState<string[] | null>(null);
  const searchId = useId();

  const selected = edit ?? linkedKeysForSite(linked, site.id);
  const all: TrackerSpaceSummary[] = spaces.data ?? [];
  const visible = filterSpaces(all, search);
  const atLimit = selected.length >= MAX_LINKED_SPACES;
  const unauthorised = isJiraUnauthorised(spaces.error) || isJiraUnauthorised(link.error);

  if (unauthorised) return <ReconnectNotice />;

  const save = () => link.mutate({ siteId: site.id, keys: selected }, { onSuccess: () => setEdit(null) });

  return (
    <fieldset className="checkbox-group jira-picker">
      <legend>{copy.jira.spacesLegend}</legend>
      <p className="field-hint">{copy.jira.spacesHint(MAX_LINKED_SPACES)}</p>
      {spaces.isPending && <p role="status">{copy.jira.loadingSpaces}</p>}
      {spaces.isError && (
        <p className="notice notice-error" role="alert">
          {errorText(spaces.error)}
        </p>
      )}
      {spaces.isSuccess && all.length === 0 && <p>{copy.jira.noSpaces}</p>}
      {all.length > 0 && (
        <>
          <div className="field">
            <label htmlFor={searchId}>{copy.jira.searchLabel}</label>
            <input
              id={searchId}
              type="search"
              className="input"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <p className="field-hint" role="status">
            {copy.jira.showing(visible.length, all.length)}. {copy.jira.selectedCount(selected.length)}.
            {atLimit ? ` ${copy.jira.limitReached(MAX_LINKED_SPACES)}` : ""}
          </p>
          {visible.length === 0 && <p>{copy.jira.noMatches}</p>}
          <ul className="jira-space-list">
            {visible.map((space) => {
              const checked = selected.includes(space.key);
              return (
                <li key={space.key} className="jira-space">
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={!checked && atLimit}
                      onChange={(event) => setEdit(toggleKey(selected, space.key, event.target.checked))}
                    />
                    <span>
                      {space.name} <span className="mono text-muted">{space.key}</span>
                    </span>
                  </label>
                  {checked && <SpaceFlow siteId={site.id} spaceKey={space.key} name={space.name} />}
                </li>
              );
            })}
          </ul>
        </>
      )}
      {link.isError && (
        <p className="notice notice-error" role="alert">
          {errorText(link.error)}
        </p>
      )}
      {link.isSuccess && edit === null && (
        <p className="notice notice-info" role="status">
          {copy.jira.linksSaved}
        </p>
      )}
      <div className="form-actions">
        <button type="button" className="button button-primary" disabled={link.isPending || !spaces.isSuccess} onClick={save}>
          {link.isPending ? copy.jira.savingLinks : copy.jira.saveLinks}
        </button>
      </div>
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
 * unless the server has Jira switched on.
 */
export function JiraSpacesPanel({ repoId }: { repoId: number }) {
  const health = useHealth();
  const enabled = health.data?.jira === true;
  const jira = useJira(enabled);
  const [params, setParams] = useSearchParams();
  const titleId = useId();

  if (!enabled) return null;

  const failed = params.get(ERROR_PARAM) === "error";
  const dismiss = () => {
    const next = new URLSearchParams(params);
    next.delete(ERROR_PARAM);
    setParams(next, { replace: true });
  };

  let body;
  if (jira.isPending) body = <p role="status">{copy.jira.loading}</p>;
  else if (jira.isError) {
    body = isJiraUnauthorised(jira.error) ? (
      <ReconnectNotice />
    ) : (
      <p className="notice notice-error" role="alert">
        {errorText(jira.error)}
      </p>
    );
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
      {failed && <ConnectFailedNotice onDismiss={dismiss} />}
      {body}
    </section>
  );
}
