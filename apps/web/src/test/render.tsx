import type { ReactElement } from "react";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { vi } from "vitest";

export function renderRoute(ui: ReactElement, { path = "/", route = "/" }: { path?: string; route?: string } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const result = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>
        <Routes>
          <Route path={path} element={ui} />
          <Route path="*" element={<p>Elsewhere</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...result, client };
}

export interface MockResponse {
  status?: number;
  body?: unknown;
}

export type Handler = (url: URL, init: RequestInit | undefined) => MockResponse | Promise<MockResponse>;

/**
 * Replaces fetch with a router keyed on "METHOD /path". Unmatched requests fail the test loudly.
 * Returns the mock so tests can inspect calls.
 */
export function mockFetch(routes: Record<string, Handler | MockResponse>) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = (init?.method ?? "GET").toUpperCase();
    const route = routes[`${method} ${url.pathname}`];
    if (!route) throw new Error(`Unexpected request ${method} ${url.pathname}`);
    const response = typeof route === "function" ? await route(url, init) : route;
    const status = response.status ?? 200;
    return new Response(status === 204 || response.body === undefined ? null : JSON.stringify(response.body), {
      status,
      headers: { "content-type": "application/json" },
    });
  });
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}
