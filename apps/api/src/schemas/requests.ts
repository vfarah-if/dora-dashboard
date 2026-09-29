/** JSON schemas Fastify validates request bodies and query strings against before a handler runs. */

const workflowList = { type: "array", items: { type: "string", maxLength: 200 }, maxItems: 10 } as const;
const branch = { type: "string", maxLength: 200 } as const;
const date = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" } as const;

export const idParams = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "integer", minimum: 1 } },
} as const;

export const addRepoBody = {
  type: "object",
  required: ["repo"],
  additionalProperties: false,
  properties: { repo: { type: "string", minLength: 3, maxLength: 300 }, deployWorkflows: workflowList, deployBranch: branch },
} as const;

export const configureRepoBody = {
  type: "object",
  required: ["deployWorkflows", "deployBranch"],
  additionalProperties: false,
  properties: { deployWorkflows: workflowList, deployBranch: branch },
} as const;

export const reportQuery = {
  type: "object",
  properties: { from: date, to: date, includeBots: { type: "string", enum: ["0", "1"] } },
} as const;

export const compareQuery = {
  type: "object",
  required: ["ids"],
  properties: { ...reportQuery.properties, ids: { type: "string", pattern: "^\\d+(,\\d+){0,5}$" } },
} as const;

export const crawlQuery = {
  type: "object",
  properties: { full: { type: "string", enum: ["0", "1"] } },
} as const;
