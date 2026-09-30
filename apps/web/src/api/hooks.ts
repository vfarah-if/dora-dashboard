import { useEffect, useRef } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CodeHealthResponse, Repo, RepoReport } from "@dora-dashboard/core";
import { apiRequest } from "./client";

export interface AuthUser {
  login: string;
  avatarUrl: string;
}

export interface AuthState {
  mode: "gh-cli" | "oauth";
  user: AuthUser | null;
  error: string | null;
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
