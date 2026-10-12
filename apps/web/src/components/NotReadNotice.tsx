import { useCrawl, useRepos } from "../api/hooks";
import type { SecurityReport } from "@dora-dashboard/core";
import { copy } from "../copy";
import { notReadKind, unusedSources } from "../lib/security";

const c = copy.security.notRead;

/**
 * Shown in place of empty figures when no alert source has been read yet. It offers an incremental crawl, the same
 * one the repository page starts, and shows that one is running. The repository list is polled during a crawl, and the
 * report is read again when it finishes.
 */
export function NotReadNotice({ repoId, sources }: { repoId: number; sources: SecurityReport["sources"] }) {
  const crawl = useCrawl();
  const crawling = useRepos().data?.find((r) => r.id === repoId)?.crawlStatus === "crawling" || crawl.isPending;
  if (notReadKind(sources) === "refused") {
    const unused = unusedSources(sources);
    const retryable = unused.some((source) => source.status === "error");
    const r = c.refused;
    return (
      <aside className="notice notice-warning not-read">
        <p className="notice-title">{r.title}</p>
        <p>{r.body}</p>
        <ul>
          {unused.map((source) => (
            <li key={source.id}>
              <strong>{source.name}</strong> {source.detail}
              {source.enable && <> {source.enable}</>}
            </li>
          ))}
        </ul>
        {retryable && (
          <>
            <p>{r.retry}</p>
            <button
              type="button"
              className="button button-secondary screen-only"
              disabled={crawling}
              onClick={() => crawl.mutate({ id: repoId, full: false })}
            >
              {crawling ? c.crawling : c.crawl}
            </button>
          </>
        )}
        {crawl.isError && <p>{c.failed}</p>}
      </aside>
    );
  }
  return (
    <aside className="notice notice-info not-read">
      <p className="notice-title">{c.title}</p>
      <p>{c.body}</p>
      <button
        type="button"
        className="button button-secondary screen-only"
        disabled={crawling}
        onClick={() => crawl.mutate({ id: repoId, full: false })}
      >
        {crawling ? c.crawling : c.crawl}
      </button>
      {crawling && (
        <p role="status" className="visually-hidden">
          {c.crawling}
        </p>
      )}
      {crawl.isError && <p>{c.failed}</p>}
    </aside>
  );
}
