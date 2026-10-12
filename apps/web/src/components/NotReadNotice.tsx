import { useCrawl, useRepos } from "../api/hooks";
import type { SecurityReport } from "@dora-dashboard/core";
import { copy } from "../copy";
import { notReadKind, unusedSources } from "../lib/security";

const c = copy.security.notRead;

/**
 * Shown in place of empty figures when no alert source has been read yet. It offers an incremental crawl, the same one
 * the repositories list starts, and shows that one is running. The repository list is polled during a crawl, and the
 * report is read again when it finishes. The status region is in the page from the first render, because a live region
 * that is mounted together with its text is not reliably announced.
 */
export function NotReadNotice({ repoId, sources }: { repoId: number; sources: SecurityReport["sources"] }) {
  const crawl = useCrawl();
  const crawling = useRepos().data?.find((r) => r.id === repoId)?.crawlStatus === "crawling" || crawl.isPending;
  const progress = (
    <p role="status" className="visually-hidden">
      {crawling ? c.crawling : ""}
    </p>
  );
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
        {progress}
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
      {progress}
      {crawl.isError && <p>{c.failed}</p>}
    </aside>
  );
}
