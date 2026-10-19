import { useEffect, useRef, useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AcceptanceRequest,
  CodeDetailResponse,
  CodeHealthResponse,
  FindingAcceptance,
  IssueLabelDefaults,
  IssueLabelRules,
  IssueReport,
  JiraConnection,
  LinkedSpace,
  Repo,
  RepoListing,
  RepoReport,
  ReviewExemptionDefaults,
  ReviewExemptionRules,
  ReviewQueue,
  SecurityReport,
  SecuritySummary,
  SpaceDescription,
  SpaceListing,
  SpaceReport,
  TrackerSpaceSummary,
} from "@dora-dashboard/core";
import { ApiError, apiRequest } from "./client";

export interface AuthUser {
  login: string;
  avatarUrl: string;
}

export interface AuthState {
  mode: "gh-cli" | "oauth";
  user: AuthUser | null;
  error: string | null;
  /** True when the API can start a GitHub device code sign-in. Treat as false when absent. */
  deviceFlow?: boolean;
  /** How the current user signed in. Absent on older servers. */
  source?: "cli" | "device" | "oauth" | null;
}

export interface DeviceStart {
  userCode: string;
  verificationUri: string;
  /** Seconds between polls. */
  interval: number;
  /** Seconds until the code lapses. */
  expiresIn: number;
}

export interface DevicePoll {
  status: "pending" | "granted" | "expired" | "denied";
  interval: number;
  user?: AuthUser;
}

/** The part of the page range that decides which merged pull requests count towards the testing figure. */
export interface CodeHealthRange {
  from: string | null;
  to: string | null;
}

export interface ReportRange {
  from: string | null;
  to: string | null;
  includeBots: boolean;
  /** The id of the DORA profile to grade against. The server default applies when absent. */
  profile?: string | null;
}

export interface AddRepoBody {
  repo: string;
  deployWorkflows?: string[];
  deployBranch?: string;
}

export interface DeployConfigBody {
  deployWorkflows: string[];
  deployBranch: string;
}

export const queryKeys = {
  me: ["auth", "me"] as const,
  repos: ["repos"] as const,
  workflows: (id: number) => ["repos", id, "workflows"] as const,
  report: (id: number, range: ReportRange, excludeAuthors: readonly string[]) => ["report", id, range, excludeAuthors] as const,
  codeHealth: (id: number, range?: CodeHealthRange) =>
    range ? (["code-health", id, range] as const) : (["code-health", id] as const),
  codeDetail: (id: number, area: string | null) => ["code-detail", id, area] as const,
  compare: (ids: readonly number[], range: ReportRange) => ["compare", ids, range] as const,
  reviewQueue: (ids: readonly number[], names = false) => ["review-queue", ids, names] as const,
  health: ["health"] as const,
  jira: ["jira"] as const,
  jiraSpaces: (siteId: string) => ["jira", "sites", siteId, "spaces"] as const,
  jiraSpace: (siteId: string, key: string) => ["jira", "sites", siteId, "spaces", key] as const,
  linkedSpaces: (repoId: number) => ["repos", repoId, "spaces"] as const,
  spaces: ["spaces"] as const,
  spaceReport: (id: number, range: SpaceRange, people: boolean) => ["spaces", id, "report", range, people] as const,
  issueLabelDefaults: ["issue-label-defaults"] as const,
  reviewExemptionDefaults: ["review-exemption-defaults"] as const,
  issues: (id: number) => ["issues", id] as const,
  issueReport: (id: number, range: SpaceRange, people: boolean) => ["issues", id, "report", range, people] as const,
  securityList: ["security-list"] as const,
  security: (id: number, range: SpaceRange) => ["security", id, range] as const,
};

/** The part of the page range a space report reads. Bots do not apply to issues. */
export type SpaceRange = Pick<ReportRange, "from" | "to">;

export function rangeQuery(range: ReportRange): string {
  const params = new URLSearchParams();
  if (range.from) params.set("from", range.from);
  if (range.to) params.set("to", range.to);
  if (range.includeBots) params.set("includeBots", "1");
  if (range.profile) params.set("profile", range.profile);
  return params.toString();
}

const withQuery = (path: string, query: string) => (query ? `${path}?${query}` : path);

export const CRAWL_POLL_MS = 2000;

export function useMe() {
  return useQuery({ queryKey: queryKeys.me, queryFn: () => apiRequest<AuthState>("/api/auth/me"), staleTime: 60_000 });
}

export function useLogout() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => apiRequest<void>("/api/auth/logout", { method: "POST" }),
    onSuccess: () => {
      client.removeQueries({ predicate: (query) => query.queryKey[0] !== queryKeys.me[0] });
      return client.invalidateQueries({ queryKey: queryKeys.me });
    },
  });
}

/** The repository list, polled every two seconds while any repository is crawling. */
export function useRepos() {
  return useQuery({
    queryKey: queryKeys.repos,
    queryFn: () => apiRequest<RepoListing[]>("/api/repos"),
    refetchInterval: (query) => (query.state.data?.some((r) => r.crawlStatus === "crawling") ? CRAWL_POLL_MS : false),
  });
}

export function useAddRepo() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: AddRepoBody) => apiRequest<Repo>("/api/repos", { method: "POST", body }),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.repos }),
  });
}

export function useUpdateRepo(id: number) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: DeployConfigBody) => apiRequest<Repo>(`/api/repos/${id}`, { method: "PATCH", body }),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.repos }),
  });
}

export function useDeleteRepo() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => apiRequest<void>(`/api/repos/${id}`, { method: "DELETE" }),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.repos }),
  });
}

export function useCrawl() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, full }: { id: number; full: boolean }) =>
      apiRequest<unknown>(withQuery(`/api/repos/${id}/crawl`, full ? "full=1" : ""), { method: "POST" }),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.repos }),
  });
}

export function useWorkflows(id: number, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.workflows(id),
    queryFn: () => apiRequest<string[]>(`/api/repos/${id}/workflows`),
    enabled,
  });
}

/** True for a whole number above zero, the only kind of id the API hands out. An address like /spaces/abc is not one. */
export const isRecordId = (id: number): boolean => Number.isInteger(id) && id > 0;

/** One repository's report. Excluded authors' pull requests are left out of every figure by the API. */
export function useReport(id: number, range: ReportRange, excludeAuthors: readonly string[] = []) {
  return useQuery({
    queryKey: queryKeys.report(id, range, excludeAuthors),
    queryFn: ({ signal }) => {
      const params = new URLSearchParams(rangeQuery(range));
      if (excludeAuthors.length) params.set("excludeAuthors", excludeAuthors.join(","));
      return apiRequest<RepoReport>(withQuery(`/api/repos/${id}/report`, params.toString()), { signal });
    },
    enabled: isRecordId(id),
    placeholderData: keepPreviousData,
  });
}

export function useCompare(ids: readonly number[], range: ReportRange) {
  return useQuery({
    queryKey: queryKeys.compare(ids, range),
    queryFn: ({ signal }) => {
      const params = new URLSearchParams(rangeQuery(range));
      params.set("ids", ids.join(","));
      return apiRequest<RepoReport[]>(`/api/compare?${params.toString()}`, { signal });
    },
    enabled: ids.length >= 2,
    placeholderData: keepPreviousData,
  });
}

/** Invalidates a repository's queries of one kind when a crawl of it finishes, so the figures come from the new snapshot. */
export function useRefetchAfterCrawl(id: number, kind: "code-health" | "code-detail" | "security") {
  const client = useQueryClient();
  const repos = useRepos();
  const crawling = repos.data?.find((r) => r.id === id)?.crawlStatus === "crawling";
  const wasCrawling = useRef(false);
  useEffect(() => {
    if (wasCrawling.current && !crawling) void client.invalidateQueries({ queryKey: [kind, id] });
    wasCrawling.current = crawling;
  }, [client, crawling, id, kind]);
}

/**
 * Invalidates the queries under `queryKey` when any crawl finishes, so a page built from every repository, such as the
 * security list, is read again once the crawl has changed what it shows. It follows the repository list, which is polled
 * while a crawl runs.
 */
export function useRefetchAfterAnyCrawl(queryKey: readonly unknown[]) {
  // Callers pass a constant key, so the effect below runs again only when the set of crawling repositories changes.
  const client = useQueryClient();
  const repos = useRepos();
  const crawling = (repos.data ?? []).filter((r) => r.crawlStatus === "crawling").map((r) => r.id);
  const before = useRef<readonly number[]>([]);
  const key = crawling.join(",");
  useEffect(() => {
    const now = key ? key.split(",").map(Number) : [];
    if (before.current.some((id) => !now.includes(id))) void client.invalidateQueries({ queryKey });
    before.current = now;
  }, [client, key, queryKey]);
}

/**
 * The latest code health for a repository. `range` only decides which merged pull requests count towards the
 * testing figure. It refetches when a crawl of that repository finishes.
 */
export function useCodeHealth(id: number, range: CodeHealthRange = { from: null, to: null }) {
  useRefetchAfterCrawl(id, "code-health");
  const params = new URLSearchParams();
  if (range.from) params.set("from", range.from);
  if (range.to) params.set("to", range.to);
  const query = params.toString();
  return useQuery({
    queryKey: queryKeys.codeHealth(id, { from: range.from, to: range.to }),
    queryFn: ({ signal }) => apiRequest<CodeHealthResponse>(withQuery(`/api/repos/${id}/code-health`, query), { signal }),
    enabled: isRecordId(id),
    // Kept only within one repository, so moving between two repositories' addresses never shows the first one's figures.
    placeholderData: (previous, previousQuery) => (previousQuery?.queryKey[1] === id ? previous : undefined),
  });
}

/**
 * The detailed code analysis of a repository: areas, the figures for one area and measured coverage. `area` is the
 * path of an area, or null for the whole repository. Nothing in it depends on the date range. It refetches when a
 * crawl of that repository finishes.
 */
export function useCodeDetail(id: number, area: string | null) {
  useRefetchAfterCrawl(id, "code-detail");
  const params = new URLSearchParams();
  if (area) params.set("area", area);
  return useQuery({
    queryKey: queryKeys.codeDetail(id, area),
    queryFn: ({ signal }) =>
      apiRequest<CodeDetailResponse>(withQuery(`/api/repos/${id}/code-detail`, params.toString()), { signal }),
    enabled: isRecordId(id),
    // Kept only within one repository, so moving between two repositories' addresses never shows the first one's figures.
    placeholderData: (previous, previousQuery) => (previousQuery?.queryKey[1] === id ? previous : undefined),
  });
}

export const REVIEW_QUEUE_POLL_MS = 60_000;

export interface ReviewQueueOptions {
  ids?: readonly number[];
  /** Ask for author logins and requested reviewer names. Without it the API leaves them out. */
  names?: boolean;
}

/** The most repository ids one request may name, as the API's `ids` and `refreshIds` allow. */
const MOST_IDS_PER_REQUEST = 50;

/**
 * What a review queue request asks the API to read again. Absent means nothing: the answer may come from the API's
 * cache. "all" sends `refresh=1`. `only` sends `refreshIds`, which the API refuses when empty or over the limit, so
 * callers name only a list that is neither.
 */
type RefreshScope = "all" | { only: readonly number[] } | undefined;

const queuePath = (ids: readonly number[], names: boolean, scope: RefreshScope) => {
  const params = new URLSearchParams();
  if (ids.length) params.set("ids", ids.join(","));
  if (names) params.set("names", "1");
  if (scope === "all") params.set("refresh", "1");
  else if (scope) params.set("refreshIds", scope.only.join(","));
  return withQuery("/api/review-queue", params.toString());
};

/** An absent list, an empty one or one longer than a request may name means every repository. */
const scopeOf = (only: readonly number[] | undefined): RefreshScope =>
  only && only.length > 0 && only.length <= MOST_IDS_PER_REQUEST ? { only } : "all";

/** What one refresh was asked, kept with it so an answer lands under the key it was asked for, not the latest render's. */
interface RefreshRequest {
  key: ReturnType<typeof queryKeys.reviewQueue>;
  ids: readonly number[];
  names: boolean;
  only: readonly number[] | undefined;
}

interface RefreshFailure {
  at: number;
  /** The query key as text, so a failure for one setting is not reported against another. */
  key: string;
  error: unknown;
}

/**
 * The live review queue, polled every minute. `refresh(only)` asks the API to skip its cache for the repositories in
 * `only`, or for every one when it is absent, empty or too long to name in one request. The answer is written into
 * the query, and the data already on screen stays until it arrives. Names are only requested when asked for.
 * `refreshFailed` holds from a failed refresh until the next answer, from a poll or a refresh, arrives, and
 * `refreshError` is that failure. A poll landing during a refresh does not end it.
 */
export function useReviewQueue({ ids = [], names = false }: ReviewQueueOptions = {}) {
  const client = useQueryClient();
  const key = queryKeys.reviewQueue(ids, names);
  const keyText = JSON.stringify(key);
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => apiRequest<ReviewQueue>(queuePath(ids, names, undefined), { signal }),
    refetchInterval: REVIEW_QUEUE_POLL_MS,
    placeholderData: keepPreviousData,
  });
  // Kept here, not read from the mutation, because resetting a mutation detaches it from the request still running.
  const [failure, setFailure] = useState<RefreshFailure | null>(null);
  const refresh = useMutation({
    // A poll still in flight must not land after, and overwrite, the fresher answer.
    onMutate: (request: RefreshRequest) => {
      setFailure(null);
      return client.cancelQueries({ queryKey: request.key });
    },
    mutationFn: (request: RefreshRequest) =>
      apiRequest<ReviewQueue>(queuePath(request.ids, request.names, scopeOf(request.only))),
    onSuccess: (data, request) => client.setQueryData(request.key, data),
    onError: (error, request) => setFailure({ at: Date.now(), key: JSON.stringify(request.key), error }),
  });
  const failed = failure !== null && failure.key === keyText && failure.at > query.dataUpdatedAt;
  return {
    ...query,
    refresh: (only?: readonly number[]) => refresh.mutate({ key, ids, names, only }),
    refreshing: refresh.isPending,
    refreshFailed: failed,
    refreshError: failed ? failure.error : null,
  };
}

export interface Health {
  /** True when Jira is configured on the server. Treat as false when absent. */
  jira?: boolean;
  /** True when the OSV.dev lookup of locked dependencies is switched on. Treat as false when absent. */
  osv?: boolean;
  /** True when the OpenSSF Scorecard lookup is switched on. Treat as false when absent. */
  scorecard?: boolean;
}

/** Whether optional features, Jira among them, are switched on. */
export function useHealth() {
  return useQuery({
    queryKey: queryKeys.health,
    queryFn: () => apiRequest<Health>("/api/health"),
    staleTime: 60_000,
    // No retries, so a page waiting on health shows its error at once. The header never remounts, so a failed probe is
    // asked again every 30 seconds until it answers, at one request each.
    retry: false,
    refetchInterval: (query) => (query.state.status === "error" ? 30_000 : false),
  });
}

export function useJira(enabled: boolean) {
  return useQuery({ queryKey: queryKeys.jira, queryFn: () => apiRequest<JiraConnection>("/api/jira"), enabled });
}

/** Revokes the stored Jira grant and invalidates every query under the `jira` key, so the connection and live space lists are read again. */
export function useDisconnectJira() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => apiRequest<void>("/api/jira", { method: "DELETE" }),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.jira }),
  });
}

/** Every space on a site, read live from Jira, so the list can run to hundreds. */
export function useJiraSpaces(siteId: string) {
  return useQuery({
    queryKey: queryKeys.jiraSpaces(siteId),
    queryFn: ({ signal }) =>
      apiRequest<TrackerSpaceSummary[]>(`/api/jira/sites/${encodeURIComponent(siteId)}/spaces`, { signal }),
    enabled: siteId !== "",
    retry: false,
  });
}

/** One space's statuses and board columns, read when someone asks how it flows. */
export function useJiraSpaceDetail(siteId: string, key: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.jiraSpace(siteId, key),
    queryFn: ({ signal }) =>
      apiRequest<SpaceDescription>(`/api/jira/sites/${encodeURIComponent(siteId)}/spaces/${encodeURIComponent(key)}`, {
        signal,
      }),
    enabled,
    retry: false,
  });
}

/**
 * The spaces linked to a repository, polled every `CRAWL_POLL_MS` while any is crawling. When a space moves into
 * failed from any other status, including idle, the Jira connection is read again, since a crawl that Jira refused drops the grant.
 */
export function useLinkedSpaces(repoId: number, enabled: boolean) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: queryKeys.linkedSpaces(repoId),
    queryFn: () => apiRequest<LinkedSpace[]>(`/api/repos/${repoId}/spaces`),
    enabled,
    refetchInterval: (q) => (q.state.data?.some((s) => s.crawlStatus === "crawling") ? CRAWL_POLL_MS : false),
  });
  const seen = useRef<Map<number, LinkedSpace["crawlStatus"]> | null>(null);
  const data = query.data;
  useEffect(() => {
    if (!data) return;
    const before = seen.current;
    seen.current = new Map(data.map((s) => [s.id, s.crawlStatus]));
    if (before && data.some((s) => s.crawlStatus === "failed" && before.has(s.id) && before.get(s.id) !== "failed")) {
      void client.invalidateQueries({ queryKey: queryKeys.jira });
    }
  }, [data, client]);
  return query;
}

/** Replaces the repository's linked spaces on one site; spaces on other sites stay linked. An empty list unlinks only that site's. */
export function useLinkSpaces(repoId: number) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: { siteId: string; keys: string[] }) =>
      apiRequest<LinkedSpace[]>(`/api/repos/${repoId}/spaces`, { method: "PUT", body }),
    onSuccess: (linked) => {
      client.setQueryData(queryKeys.linkedSpaces(repoId), linked);
      return client.invalidateQueries({ queryKey: queryKeys.linkedSpaces(repoId) });
    },
  });
}

export function useCrawlSpace(repoId: number) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, full }: { id: number; full: boolean }) =>
      apiRequest<unknown>(withQuery(`/api/spaces/${id}/crawl`, full ? "full=1" : ""), { method: "POST" }),
    // A refused crawl (already running) still means the list is out of date, so refresh on either outcome.
    onSettled: () => client.invalidateQueries({ queryKey: queryKeys.linkedSpaces(repoId) }),
  });
}

/** Every tracked space. Only asked for when Jira is switched on, since the route is absent otherwise. */
export function useSpaces(enabled = true) {
  return useQuery({
    queryKey: queryKeys.spaces,
    queryFn: ({ signal }) => apiRequest<SpaceListing[]>("/api/spaces", { signal }),
    enabled,
    retry: false,
    refetchInterval: (query) => (query.state.data?.some((s) => s.crawlStatus === "crawling") ? CRAWL_POLL_MS : false),
  });
}

/** One space's delivery report. Names are asked for only when `people` is true (ADR 0008). */
export function useSpaceReport(id: number, range: SpaceRange, people: boolean) {
  return useQuery({
    queryKey: queryKeys.spaceReport(id, range, people),
    queryFn: ({ signal }) => {
      const params = new URLSearchParams();
      if (range.from) params.set("from", range.from);
      if (range.to) params.set("to", range.to);
      if (people) params.set("people", "1");
      return apiRequest<SpaceReport>(withQuery(`/api/spaces/${id}/report`, params.toString()), { signal });
    },
    enabled: isRecordId(id),
    retry: false,
    // A range change keeps the old figures on screen. Moving to another space never does, so one space's report is
    // not shown under the next one's address; nor does turning names on or off, so a report fetched without names
    // is not shown as "unassigned" while the one with names loads.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === id && previousQuery.queryKey[4] === people ? previous : undefined,
  });
}

/**
 * One repository's GitHub Issues report. Names are asked for only when `people` is true (ADR 0008). It refetches when a
 * crawl of that repository finishes, since the crawl is what reads the issues.
 */
export function useIssueReport(id: number, range: SpaceRange, people: boolean) {
  const client = useQueryClient();
  const repos = useRepos();
  const crawling = repos.data?.find((r) => r.id === id)?.crawlStatus === "crawling";
  const wasCrawling = useRef(false);
  useEffect(() => {
    if (wasCrawling.current && !crawling) void client.invalidateQueries({ queryKey: queryKeys.issues(id) });
    wasCrawling.current = crawling;
  }, [client, crawling, id]);
  return useQuery({
    queryKey: queryKeys.issueReport(id, range, people),
    queryFn: ({ signal }) => {
      const params = new URLSearchParams();
      if (range.from) params.set("from", range.from);
      if (range.to) params.set("to", range.to);
      if (people) params.set("people", "1");
      return apiRequest<IssueReport>(withQuery(`/api/repos/${id}/issues/report`, params.toString()), { signal });
    },
    enabled: isRecordId(id),
    retry: false,
    // A range change keeps the old figures on screen. Another repository's report is never shown under this one's
    // address, and a report fetched without names is not shown while the one with names loads.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === id && previousQuery.queryKey[4] === people ? previous : undefined,
  });
}

/** The label names the API classifies issues with until a repository overrides them, and the limits an override keeps to. */
export function useIssueLabelDefaults() {
  return useQuery({
    queryKey: queryKeys.issueLabelDefaults,
    queryFn: () => apiRequest<IssueLabelDefaults>("/api/issue-labels/defaults"),
    // The defaults change only with a release of the API, so reading them once an hour is plenty.
    staleTime: 60 * 60 * 1000,
  });
}

/**
 * Saves a repository's label override, or clears it with null. The report is built from stored issues, so no crawl
 * follows: the listing and the report are read again.
 */
export function useUpdateIssueLabels(id: number) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (labels: IssueLabelRules | null) =>
      apiRequest<RepoListing>(`/api/repos/${id}/issue-labels`, { method: "PUT", body: { labels } }),
    onSuccess: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.repos }),
        client.invalidateQueries({ queryKey: queryKeys.issues(id) }),
      ]),
  });
}

/** The title words and labels that leave a pull request out of "merged with no review", and the limits an override keeps to. */
export function useReviewExemptionDefaults() {
  return useQuery({
    queryKey: queryKeys.reviewExemptionDefaults,
    queryFn: () => apiRequest<ReviewExemptionDefaults>("/api/review-exemptions/defaults"),
    // The defaults change only with a release of the API, so reading them once an hour is plenty.
    staleTime: 60 * 60 * 1000,
  });
}

/**
 * Saves a repository's review exemptions, or clears them with null. The figure is worked out when the report is built,
 * so no crawl follows: the listing and every report are read again.
 */
export function useUpdateReviewExemptions(id: number) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (exemptions: ReviewExemptionRules | null) =>
      apiRequest<RepoListing>(`/api/repos/${id}/review-exemptions`, { method: "PUT", body: { exemptions } }),
    onSuccess: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.repos }),
        client.invalidateQueries({ queryKey: ["report", id] }),
        client.invalidateQueries({ queryKey: ["compare"] }),
      ]),
  });
}

/**
 * The security summary of every repository, worst first as the API orders it. It refetches when any crawl finishes,
 * since the crawl is what reads the alerts.
 */
export function useSecurityList() {
  useRefetchAfterAnyCrawl(queryKeys.securityList);
  return useQuery({
    queryKey: queryKeys.securityList,
    queryFn: ({ signal }) => apiRequest<SecuritySummary[]>("/api/security", { signal }),
    retry: false,
  });
}

/**
 * One repository's security report. The grade and the open alerts describe now, and the range scopes the weekly chart,
 * time to fix and dismissals. It refetches when a crawl of that repository finishes.
 */
export function useSecurityReport(id: number, range: SpaceRange) {
  useRefetchAfterCrawl(id, "security");
  return useQuery({
    queryKey: queryKeys.security(id, range),
    queryFn: ({ signal }) => {
      const params = new URLSearchParams();
      if (range.from) params.set("from", range.from);
      if (range.to) params.set("to", range.to);
      return apiRequest<SecurityReport>(withQuery(`/api/repos/${id}/security`, params.toString()), { signal });
    },
    enabled: isRecordId(id),
    retry: false,
    // A range change keeps the old figures on screen, but another repository's report is never shown under this one's address.
    placeholderData: (previous, previousQuery) => (previousQuery?.queryKey[1] === id ? previous : undefined),
  });
}

/** Reads one repository's security report and the list of summaries again, so an acceptance shows in both. */
function refreshSecurity(client: ReturnType<typeof useQueryClient>, id: number) {
  return Promise.all([
    client.invalidateQueries({ queryKey: ["security", id] }),
    client.invalidateQueries({ queryKey: queryKeys.securityList }),
  ]);
}

/**
 * Accepts a finding with a reason and a note. Both the report and the list are read again. A 409 carries one code for
 * its cause (no record, the finding changed, already accepted or the limit reached), and the report is read again to
 * show what is there now.
 */
export function useAcceptFinding(id: number) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (request: AcceptanceRequest) =>
      apiRequest<FindingAcceptance>(`/api/repos/${id}/security/acceptances`, { method: "POST", body: request }),
    onSuccess: () => refreshSecurity(client, id),
    onError: (error) => (error instanceof ApiError && error.status === 409 ? refreshSecurity(client, id) : undefined),
  });
}

/** Takes an acceptance away, so the finding it covered counts again, or an entry that no longer applies is tidied. */
export function useRemoveAcceptance(id: number) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (acceptanceId: number) =>
      apiRequest<undefined>(`/api/repos/${id}/security/acceptances/${acceptanceId}`, { method: "DELETE" }),
    onSuccess: () => refreshSecurity(client, id),
    // Already gone, for example removed in another tab, so the stale entry is read away.
    onError: (error) => (error instanceof ApiError && error.status === 404 ? refreshSecurity(client, id) : undefined),
  });
}
