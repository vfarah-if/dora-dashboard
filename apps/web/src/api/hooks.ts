import { useEffect, useRef } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  BoardColumn,
  CodeHealthResponse,
  Repo,
  RepoReport,
  ReviewQueue,
  TrackerSite,
  TrackerSpace,
  TrackerSpaceSummary,
  TrackerStatus,
} from "@dora-dashboard/core";
import { apiRequest } from "./client";

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

export type RepoWithCounts = Repo & { pullRequests: number; deployRuns: number };

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
  compare: (ids: readonly number[], range: ReportRange) => ["compare", ids, range] as const,
  reviewQueue: (ids: readonly number[], names = false) => ["review-queue", ids, names] as const,
  health: ["health"] as const,
  jira: ["jira"] as const,
  jiraSpaces: (siteId: string) => ["jira", "sites", siteId, "spaces"] as const,
  jiraSpace: (siteId: string, key: string) => ["jira", "sites", siteId, "spaces", key] as const,
  linkedSpaces: (repoId: number) => ["repos", repoId, "spaces"] as const,
};

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
    queryFn: () => apiRequest<RepoWithCounts[]>("/api/repos"),
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

/** One repository's report. Excluded authors' pull requests are left out of every figure by the API. */
export function useReport(id: number, range: ReportRange, excludeAuthors: readonly string[] = []) {
  return useQuery({
    queryKey: queryKeys.report(id, range, excludeAuthors),
    queryFn: ({ signal }) => {
      const params = new URLSearchParams(rangeQuery(range));
      if (excludeAuthors.length) params.set("excludeAuthors", excludeAuthors.join(","));
      return apiRequest<RepoReport>(withQuery(`/api/repos/${id}/report`, params.toString()), { signal });
    },
    enabled: Number.isFinite(id),
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

/**
 * The latest code health for a repository. `range` only decides which merged pull requests count towards the
 * testing figure. It refetches when a crawl of that repository finishes.
 */
export function useCodeHealth(id: number, range: CodeHealthRange = { from: null, to: null }) {
  const client = useQueryClient();
  const repos = useRepos();
  const crawling = repos.data?.find((r) => r.id === id)?.crawlStatus === "crawling";
  const wasCrawling = useRef(false);
  useEffect(() => {
    if (wasCrawling.current && !crawling) void client.invalidateQueries({ queryKey: queryKeys.codeHealth(id) });
    wasCrawling.current = crawling;
  }, [client, crawling, id]);
  const params = new URLSearchParams();
  if (range.from) params.set("from", range.from);
  if (range.to) params.set("to", range.to);
  const query = params.toString();
  return useQuery({
    queryKey: queryKeys.codeHealth(id, { from: range.from, to: range.to }),
    queryFn: ({ signal }) => apiRequest<CodeHealthResponse>(withQuery(`/api/repos/${id}/code-health`, query), { signal }),
    enabled: Number.isFinite(id),
    placeholderData: keepPreviousData,
  });
}

export const REVIEW_QUEUE_POLL_MS = 60_000;

export interface ReviewQueueOptions {
  ids?: readonly number[];
  /** Ask for author logins and requested reviewer names. Without it the API leaves them out. */
  names?: boolean;
}

const queuePath = (ids: readonly number[], names: boolean, refresh: boolean) => {
  const params = new URLSearchParams();
  if (ids.length) params.set("ids", ids.join(","));
  if (names) params.set("names", "1");
  if (refresh) params.set("refresh", "1");
  return withQuery("/api/review-queue", params.toString());
};

/**
 * The live review queue, polled every minute. `refresh()` asks the API to skip its cache and replaces the
 * shown data with the answer, while the previous data stays on screen. Names are only requested when asked for.
 */
export function useReviewQueue({ ids = [], names = false }: ReviewQueueOptions = {}) {
  const client = useQueryClient();
  const key = queryKeys.reviewQueue(ids, names);
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => apiRequest<ReviewQueue>(queuePath(ids, names, false), { signal }),
    refetchInterval: REVIEW_QUEUE_POLL_MS,
    placeholderData: keepPreviousData,
  });
  const refresh = useMutation({
    // A poll still in flight must not land after, and overwrite, the fresher answer.
    onMutate: () => client.cancelQueries({ queryKey: key }),
    mutationFn: () => apiRequest<ReviewQueue>(queuePath(ids, names, true)),
    onSuccess: (data) => client.setQueryData(key, data),
  });
  const { reset } = refresh;
  const { dataUpdatedAt } = query;
  // A failed refresh is only news until the next good answer arrives.
  useEffect(() => {
    if (dataUpdatedAt) reset();
  }, [dataUpdatedAt, reset]);
  return {
    ...query,
    refresh: () => refresh.mutate(),
    refreshing: refresh.isPending,
    refreshFailed: refresh.isError,
  };
}

export interface Health {
  /** True when Jira is configured on the server. Treat as false when absent. */
  jira?: boolean;
}

export interface JiraState {
  enabled: true;
  connected: boolean;
  sites: TrackerSite[];
}

export interface SpaceDetail {
  statuses: TrackerStatus[];
  columns: BoardColumn[];
}

export type LinkedSpace = TrackerSpace & { workItemCount: number };

/** Whether optional features, Jira among them, are switched on. */
export function useHealth() {
  return useQuery({
    queryKey: queryKeys.health,
    queryFn: () => apiRequest<Health>("/api/health"),
    staleTime: 60_000,
    retry: false,
  });
}

export function useJira(enabled: boolean) {
  return useQuery({ queryKey: queryKeys.jira, queryFn: () => apiRequest<JiraState>("/api/jira"), enabled });
}

/** Revokes the stored Jira grant. Everything read through it is dropped from the cache. */
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
      apiRequest<SpaceDetail>(`/api/jira/sites/${encodeURIComponent(siteId)}/spaces/${encodeURIComponent(key)}`, {
        signal,
      }),
    enabled,
    retry: false,
  });
}

/** The spaces linked to a repository, polled every two seconds while any is crawling. */
export function useLinkedSpaces(repoId: number, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.linkedSpaces(repoId),
    queryFn: () => apiRequest<LinkedSpace[]>(`/api/repos/${repoId}/spaces`),
    enabled,
    refetchInterval: (query) => (query.state.data?.some((s) => s.crawlStatus === "crawling") ? CRAWL_POLL_MS : false),
  });
}

/** Replaces the set of spaces linked to a repository. An empty list unlinks them all. */
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
