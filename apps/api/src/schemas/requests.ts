import { DORA_PROFILE_IDS } from "@dora-dashboard/core";

/** JSON schemas Fastify validates request bodies and query strings against before a handler runs. */

const workflowList = { type: "array", items: { type: "string", maxLength: 200 }, maxItems: 10 } as const;
/** No leading `-` (git would read it as an option), no whitespace, no control characters. */
const branch = { type: "string", maxLength: 200, pattern: "^(?!-)[^\\s\\u0000-\\u001f\\u007f]*$" } as const;
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

const rangeProperties = {
  from: date,
  to: date,
  includeBots: { type: "string", enum: ["0", "1"] },
  profile: { type: "string", enum: [...DORA_PROFILE_IDS] },
} as const;

/** One repository's report. `excludeAuthors` is a comma-separated list of logins; only this route takes it. */
export const reportQuery = {
  type: "object",
  properties: { ...rangeProperties, excludeAuthors: { type: "string", maxLength: 4000 } },
} as const;

export const compareQuery = {
  type: "object",
  required: ["ids"],
  properties: { ...rangeProperties, ids: { type: "string", pattern: "^\\d+(,\\d+){0,5}$" } },
} as const;

export const crawlQuery = {
  type: "object",
  properties: { full: { type: "string", enum: ["0", "1"] } },
} as const;

export const codeHealthQuery = {
  type: "object",
  properties: { from: date, to: date },
} as const;

/** `ids` is optional: leave it out for every repository. */
export const reviewQueueQuery = {
  type: "object",
  properties: {
    ids: { type: "string", pattern: "^\\d+(,\\d+){0,49}$" },
    refresh: { type: "string", enum: ["0", "1"] },
    names: { type: "string", enum: ["0", "1"] },
  },
} as const;

/** A relative path on the dashboard, with no host, no `//` prefix and no backslash, to come back to after consent. */
export const jiraStartQuery = {
  type: "object",
  properties: { returnTo: { type: "string", maxLength: 200, pattern: "^/(?![/\\\\])[^\\s\\u0000-\\u001f\\u007f\\\\]*$" } },
} as const;

export const jiraCallbackQuery = {
  type: "object",
  properties: {
    code: { type: "string", maxLength: 2000 },
    state: { type: "string", maxLength: 200 },
    error: { type: "string", maxLength: 200 },
    error_description: { type: "string", maxLength: 2000 },
  },
} as const;

const siteId = { type: "string", pattern: "^[A-Za-z0-9-]{1,64}$" } as const;
const spaceKey = { type: "string", pattern: "^[A-Z][A-Z0-9_]+$", maxLength: 100 } as const;

export const jiraSiteParams = {
  type: "object",
  required: ["siteId"],
  properties: { siteId },
} as const;

export const jiraSpaceParams = {
  type: "object",
  required: ["siteId", "key"],
  properties: { siteId, key: spaceKey },
} as const;

export const linkSpacesBody = {
  type: "object",
  required: ["siteId", "keys"],
  additionalProperties: false,
  properties: { siteId, keys: { type: "array", items: spaceKey, maxItems: 20 } },
} as const;
