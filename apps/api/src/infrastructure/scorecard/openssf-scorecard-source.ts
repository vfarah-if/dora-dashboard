import type { ScorecardResult } from "@dora-dashboard/core";
import { UpstreamError } from "../../core/errors.js";
import type { ScorecardSource } from "../../interfaces/scorecard-source.js";
import type { Fetch } from "../http/fetch.js";
import { parseJsonObject, readCappedText } from "../http/capped-text.js";

const ORIGIN = "https://api.securityscorecards.dev";
const TIMEOUT_MS = 30_000;
const MAX_BYTES = 1024 * 1024;
const MAX_REASON = 300;

type Json = Record<string, unknown>;
const obj = (value: unknown): Json | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : null;
const finite = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** An ISO 8601 date or date-time that names a real moment, as text, or null. The report parses this, so it must parse. */
function isoDate(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:?\d{2})?)?$/.test(value)
  ) {
    return null;
  }
  return Number.isNaN(Date.parse(value)) ? null : value;
}

/**
 * The OpenSSF Scorecard of a public repository, from its public API (ADR 0035). What follows is the service's side of
 * the `ScorecardSource` contract.
 *
 * - The origin is fixed, no `Authorization` header or cookie is sent, and a redirect is refused. The only thing that
 *   leaves is the public owner and name, which the caller sends only for a repository GitHub says is public.
 * - A 404 means the project is not in the weekly scan and answers null.
 * - Only `score`, `date` (an ISO date or date-time, else the reply is refused) and each check's `name`, `score` and
 *   `reason` are mapped; `details` and the documentation text are not. A check with no usable score (Scorecard uses -1 for "not
 *   applicable") keeps that score.
 * - The reply is read up to 1 MiB.
 */
export class OpenSsfScorecardSource implements ScorecardSource {
  readonly kind = "openssf";

  constructor(private readonly http: Fetch = fetch) {}

  async scorecard(owner: string, name: string): Promise<ScorecardResult | null> {
    const url = `${ORIGIN}/projects/github.com/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
    let response: Response;
    try {
      response = await this.http(url, {
        redirect: "error",
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { Accept: "application/json", "User-Agent": "dora-dashboard" },
      });
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new UpstreamError(`The scorecard service did not answer within ${TIMEOUT_MS / 1000} seconds`, 504, {
          cause: error,
        });
      }
      throw new UpstreamError("The scorecard service could not be reached, or tried to redirect the request", 502, {
        cause: error,
      });
    }
    if (response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new UpstreamError(`The scorecard service answered ${response.status}`, response.status);
    }
    const body = parseJsonObject(await readCappedText(response, MAX_BYTES, "The scorecard service"), "The scorecard service");
    const score = finite(body.score);
    const date = isoDate(body.date);
    if (score === null || date === null) {
      throw new UpstreamError("The scorecard service sent a reply with no score or with a date that is not valid", 502);
    }
    const checks = (Array.isArray(body.checks) ? body.checks : []).flatMap((entry: unknown) => {
      const check = obj(entry);
      const checkScore = finite(check?.score);
      if (typeof check?.name !== "string" || checkScore === null) return [];
      return [
        {
          name: check.name,
          score: checkScore,
          reason: typeof check.reason === "string" ? check.reason.slice(0, MAX_REASON) : "",
        },
      ];
    });
    return { score, date, checks };
  }
}
