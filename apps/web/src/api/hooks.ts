import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Repo, RepoReport } from "@dora-dashboard/core";
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

export interface ReportRange {
  from: string | null;
  to: string | null;
  includeBots: boolean;
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
  report: (id: number, range: ReportRange) => ["report", id, range] as const,
  compare: (ids: readonly number[], range: ReportRange) => ["compare", ids, range] as const,
};

export function rangeQuery(range: ReportRange): string {
  const params = new URLSearchParams();
  if (range.from) params.set("from", range.from);
  if (range.to) params.set("to", range.to);
  if (range.includeBots) params.set("includeBots", "1");
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

export function useReport(id: number, range: ReportRange) {
  return useQuery({
    queryKey: queryKeys.report(id, range),
    queryFn: ({ signal }) => apiRequest<RepoReport>(withQuery(`/api/repos/${id}/report`, rangeQuery(range)), { signal }),
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
