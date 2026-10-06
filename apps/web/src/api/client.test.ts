import { describe, expect, it } from "vitest";
import { mockFetch } from "../test/render";
import { copy } from "../copy";
import { ApiError, apiRequest, errorText } from "./client";

/** The error `apiRequest` throws for a response, so its status, message and code can be checked together. */
async function failure(status: number, body?: unknown): Promise<ApiError> {
  mockFetch({ "GET /api/thing": { status, body } });
  const error = await apiRequest("/api/thing").catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  return error as ApiError;
}

describe("apiRequest errors", () => {
  it("keeps the readable message and the stable code of a coded error apart", async () => {
    const error = await failure(401, { error: "Jira is not connected. Connect Jira first", code: "jira_unauthorised" });
    expect([error.status, error.message, error.code]).toEqual([
      401,
      "Jira is not connected. Connect Jira first",
      "jira_unauthorised",
    ]);
    expect(errorText(error)).toBe("Jira is not connected. Connect Jira first");
  });

  it("gives no code for an error without one", async () => {
    const error = await failure(404, { error: "Space not found" });
    expect([error.message, error.code]).toEqual(["Space not found", null]);
  });

  it("treats a code it does not know as none, still showing the message", async () => {
    const error = await failure(400, { error: "Something new went wrong", code: "something_new" });
    expect([error.message, error.code]).toEqual(["Something new went wrong", null]);
  });

  it.each([
    ["no body", undefined],
    ["a blank message", { error: "  " }],
    ["a body that is not an object", "oops"],
  ])("falls back to the status for %s", async (_name, body) => {
    const error = await failure(502, body);
    expect([error.message, error.code]).toEqual([copy.common.requestFailed(502), null]);
  });
});

describe("apiRequest successful replies", () => {
  const reply = (status: number, text: string | null) => {
    globalThis.fetch = (async () => new Response(text, { status })) as unknown as typeof fetch;
  };

  it("throws a readable error when a 2xx body cannot be parsed", async () => {
    reply(200, "<html>proxy page</html>");
    const error = await apiRequest("/api/thing").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).message).toBe(copy.common.unreadableResponse);
    expect((error as ApiError).status).toBe(200);
  });

  it("still resolves undefined for a 204 and null for an empty 200 body", async () => {
    reply(204, null);
    await expect(apiRequest("/api/thing")).resolves.toBeUndefined();
    reply(200, "");
    await expect(apiRequest("/api/thing")).resolves.toBeNull();
  });

  it("keeps the status message for a failed reply whose body cannot be parsed", async () => {
    reply(502, "Bad gateway");
    const error = await apiRequest("/api/thing").catch((e: unknown) => e);
    expect((error as ApiError).message).toBe(copy.common.requestFailed(502));
  });
});
