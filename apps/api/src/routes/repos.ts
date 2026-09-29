import type { FastifyInstance, preHandlerAsyncHookHandler } from "fastify";
import type { CrawlService } from "../services/crawl-service.js";
import type { AddRepoInput, RepoService } from "../services/repo-service.js";
import type { ReportService } from "../services/report-service.js";
import { addRepoBody, compareQuery, configureRepoBody, crawlQuery, idParams, reportQuery } from "../schemas/requests.js";

export interface RepoRouteDeps {
  guard: preHandlerAsyncHookHandler;
  repos: RepoService;
  crawler: CrawlService;
  reports: ReportService;
}

interface ReportQuery {
  from?: string;
  to?: string;
  includeBots?: "0" | "1";
}

const toOptions = (q: ReportQuery) => ({ from: q.from, to: q.to, includeBots: q.includeBots === "1" });

export function registerRepoRoutes(app: FastifyInstance, deps: RepoRouteDeps): void {
  const { guard, repos, crawler, reports } = deps;

  /** Crawls run after the response; their outcome is read back through the repository's crawl state. */
  const startCrawl = (token: string, repoId: number, full: boolean) => {
    crawler.crawl(token, repoId, full).catch((err: unknown) => app.log.warn({ err, repoId }, "crawl failed"));
  };

  app.get("/api/repos", { preHandler: guard }, async () => repos.list());

  app.post<{ Body: AddRepoInput }>("/api/repos", { preHandler: guard, schema: { body: addRepoBody } }, async (request, reply) => {
    const repo = await repos.add(request.session!.token, request.body);
    startCrawl(request.session!.token, repo.id, true);
    return reply.code(201).send(repo);
  });

  app.patch<{ Params: { id: number }; Body: { deployWorkflows: string[]; deployBranch: string } }>(
    "/api/repos/:id",
    { preHandler: guard, schema: { params: idParams, body: configureRepoBody } },
    async (request) => {
      const repo = repos.configure(request.params.id, request.body.deployWorkflows, request.body.deployBranch);
      startCrawl(request.session!.token, repo.id, false);
      return repo;
    },
  );

  app.delete<{ Params: { id: number } }>(
    "/api/repos/:id",
    { preHandler: guard, schema: { params: idParams } },
    async (request, reply) => {
      repos.remove(request.params.id);
      return reply.code(204).send();
    },
  );

  app.get<{ Params: { id: number } }>(
    "/api/repos/:id/workflows",
    { preHandler: guard, schema: { params: idParams } },
    async (request) => repos.workflows(request.session!.token, request.params.id),
  );

  app.post<{ Params: { id: number }; Querystring: { full?: "0" | "1" } }>(
    "/api/repos/:id/crawl",
    { preHandler: guard, schema: { params: idParams, querystring: crawlQuery } },
    async (request, reply) => {
      repos.get(request.params.id);
      startCrawl(request.session!.token, request.params.id, request.query.full === "1");
      return reply.code(202).send({ ok: true });
    },
  );

  app.get<{ Params: { id: number }; Querystring: ReportQuery }>(
    "/api/repos/:id/report",
    { preHandler: guard, schema: { params: idParams, querystring: reportQuery } },
    async (request) => reports.report(request.params.id, toOptions(request.query)),
  );

  app.get<{ Querystring: ReportQuery & { ids: string } }>(
    "/api/compare",
    { preHandler: guard, schema: { querystring: compareQuery } },
    async (request) => reports.compare(request.query.ids.split(",").map(Number), toOptions(request.query)),
  );
}
