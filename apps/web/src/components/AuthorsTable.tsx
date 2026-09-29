import type { AuthorRow } from "@dora-dashboard/core";
import { copy } from "../copy";
import { formatDuration } from "../lib/format";

export function AuthorsTable({ authors, caption }: { authors: readonly AuthorRow[]; caption: string }) {
  if (authors.length === 0) return <p className="chart-empty">{copy.authors.empty}</p>;
  return (
    <div className="table-scroll">
      <table className="data-table">
        <caption className="visually-hidden">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">{copy.authors.login}</th>
            <th scope="col" className="numeric">
              {copy.authors.opened}
            </th>
            <th scope="col" className="numeric">
              {copy.authors.merged}
            </th>
            <th scope="col" className="numeric">
              {copy.authors.medianOpenToMerge}
            </th>
            <th scope="col" className="numeric">
              {copy.authors.reviewsGiven}
            </th>
          </tr>
        </thead>
        <tbody>
          {authors.map((author) => (
            <tr key={author.author}>
              <th scope="row" className="mono">
                {author.author}
              </th>
              <td className="numeric">{author.opened}</td>
              <td className="numeric">{author.merged}</td>
              <td className="numeric">{formatDuration(author.medianOpenToMergeHours)}</td>
              <td className="numeric">{author.reviewsGiven}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
