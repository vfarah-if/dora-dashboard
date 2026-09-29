import { useId, useMemo, useState } from "react";
import type { PrTimings } from "@dora-dashboard/core";
import { copy } from "../copy";
import { formatDate, formatDuration, formatNumber } from "../lib/format";
import { usePrinting } from "../lib/print";
import { filterByAuthor, prAuthors } from "../lib/prs";

type SortKey = "number" | "title" | "author" | "createdAt" | "mergedAt" | "openToMergeHours" | "firstReviewHours" | "size";

const COLUMNS: { key: SortKey; label: string; numeric?: boolean }[] = [
  { key: "number", label: copy.prTable.number, numeric: true },
  { key: "title", label: copy.prTable.titleColumn },
  { key: "author", label: copy.prTable.author },
  { key: "createdAt", label: copy.prTable.opened },
  { key: "mergedAt", label: copy.prTable.merged },
  { key: "openToMergeHours", label: copy.prTable.openToMerge, numeric: true },
  { key: "firstReviewHours", label: copy.prTable.firstReview, numeric: true },
  { key: "size", label: copy.prTable.size, numeric: true },
];

export const PR_PAGE_SIZE = 20;

function compareValues(a: string | number | null, b: string | number | null): number {
  // Missing values always sort last, whichever direction is chosen, handled by the caller.
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
}

export function PrTable({ prs }: { prs: readonly PrTimings[] }) {
  const [sort, setSort] = useState<{ key: SortKey; direction: "asc" | "desc" }>({ key: "createdAt", direction: "desc" });
  const [page, setPage] = useState(0);
  const [author, setAuthor] = useState<string | null>(null);
  const authorId = useId();
  // The printed report carries every pull request, not just the page on screen.
  const printing = usePrinting();

  const authors = useMemo(() => prAuthors(prs), [prs]);
  // A chosen author who has no pull requests in a new range falls back to everyone.
  const activeAuthor = author && authors.some((option) => option.login === author) ? author : null;
  const filtered = useMemo(() => filterByAuthor(prs, activeAuthor), [prs, activeAuthor]);

  const sorted = useMemo(() => {
    const present = filtered.filter((pr) => pr[sort.key] !== null);
    const missing = filtered.filter((pr) => pr[sort.key] === null);
    present.sort((a, b) => {
      const result = compareValues(a[sort.key], b[sort.key]);
      return sort.direction === "asc" ? result : -result;
    });
    return [...present, ...missing];
  }, [filtered, sort]);

  const pages = Math.max(1, Math.ceil(sorted.length / PR_PAGE_SIZE));
  const current = Math.min(page, pages - 1);
  const visible = printing ? sorted : sorted.slice(current * PR_PAGE_SIZE, (current + 1) * PR_PAGE_SIZE);

  const sortBy = (key: SortKey) => {
    setSort((previous) =>
      previous.key === key
        ? { key, direction: previous.direction === "asc" ? "desc" : "asc" }
        : { key, direction: key === "title" || key === "author" ? "asc" : "desc" },
    );
    setPage(0);
  };

  if (prs.length === 0) return <p className="chart-empty">{copy.prTable.empty}</p>;

  return (
    <>
      {authors.length > 1 && (
        <div className="table-toolbar">
          <label htmlFor={authorId} className="field-inline table-filter">
            <span>{copy.prTable.filterAuthor}</span>
            <select
              id={authorId}
              className="input"
              value={activeAuthor ?? ""}
              onChange={(event) => {
                setAuthor(event.target.value || null);
                setPage(0);
              }}
            >
              <option value="">{copy.prTable.allAuthors(authors.length)}</option>
              {authors.map((option) => (
                <option key={option.login} value={option.login}>
                  {copy.prTable.authorOption(option.login, option.count)}
                </option>
              ))}
            </select>
          </label>
          {activeAuthor && (
            <p className="table-filter-summary" aria-live="polite">
              {copy.prTable.showingAuthor(filtered.length, prs.length, activeAuthor)}
            </p>
          )}
        </div>
      )}
      <div className="table-scroll">
        <table className="data-table pr-table">
          <caption className="visually-hidden">{copy.prTable.title}</caption>
          <thead>
            <tr>
              {COLUMNS.map((column) => {
                const active = sort.key === column.key;
                return (
                  <th
                    key={column.key}
                    scope="col"
                    className={column.numeric ? "numeric" : undefined}
                    aria-sort={active ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}
                  >
                    <button type="button" className="sort-button" onClick={() => sortBy(column.key)}>
                      {column.label}
                      <span className="sort-indicator" aria-hidden="true">
                        {active ? (sort.direction === "asc" ? "▲" : "▼") : ""}
                      </span>
                    </button>
                  </th>
                );
              })}
              <th scope="col">{copy.prTable.reviewed}</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((pr) => (
              <tr key={pr.number}>
                <td className="numeric mono">{pr.number}</td>
                <th scope="row" className="pr-title">
                  <a href={pr.url} target="_blank" rel="noopener noreferrer">
                    {pr.title}
                    <span className="visually-hidden"> {copy.common.opensInNewTab}</span>
                  </a>
                </th>
                <td className="mono">{pr.author ?? copy.common.notAvailable}</td>
                <td>{formatDate(pr.createdAt)}</td>
                <td>{pr.mergedAt ? formatDate(pr.mergedAt) : <span className="text-muted">{copy.prTable.notMerged}</span>}</td>
                <td className="numeric">{formatDuration(pr.openToMergeHours)}</td>
                <td className="numeric">{formatDuration(pr.firstReviewHours)}</td>
                <td className="numeric">{formatNumber(pr.size, 0)}</td>
                <td>{pr.reviewed ? copy.prTable.yes : copy.prTable.no}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pages > 1 && !printing && (
        <nav className="pager" aria-label={copy.prTable.title}>
          <button type="button" className="button button-secondary" disabled={current === 0} onClick={() => setPage(current - 1)}>
            {copy.prTable.previous}
          </button>
          <span aria-live="polite">{copy.prTable.pageOf(current + 1, pages)}</span>
          <button
            type="button"
            className="button button-secondary"
            disabled={current >= pages - 1}
            onClick={() => setPage(current + 1)}
          >
            {copy.prTable.next}
          </button>
        </nav>
      )}
    </>
  );
}
