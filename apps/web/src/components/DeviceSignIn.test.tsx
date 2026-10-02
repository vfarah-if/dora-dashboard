import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { App } from "../App";
import { copy } from "../copy";
import { mockFetch } from "../test/render";
import type { MockResponse } from "../test/render";

const text = copy.auth.device;
const started = { userCode: "WDJB-MJHT", verificationUri: "https://github.com/login/device", interval: 5, expiresIn: 900 };
const pending = (interval = 5): MockResponse => ({ body: { status: "pending", interval } });

function renderApp() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...view, client };
}

const signedOut = (deviceFlow?: boolean): MockResponse => ({
  body: { mode: "gh-cli", user: null, error: null, ...(deviceFlow === undefined ? {} : { deviceFlow }) },
});

const pollCount = (fetchMock: ReturnType<typeof mockFetch>) =>
  fetchMock.mock.calls.filter(([url]) => String(url) === "/api/auth/device/poll").length;

describe("device code sign-in", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const tick = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

  const press = (element: HTMLElement) => act(async () => void fireEvent.click(element));

  async function begin() {
    await tick(0);
    await press(screen.getByRole("button", { name: copy.auth.signInButton }));
    await tick(0);
  }

  it.each([false, undefined])("hides the button when deviceFlow is %s", async (flag) => {
    mockFetch({ "GET /api/auth/me": signedOut(flag) });
    renderApp();
    await tick(0);
    expect(screen.getByText(copy.auth.ghCliCommand)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: copy.auth.signInButton })).not.toBeInTheDocument();
  });

  it("keeps the CLI guidance and starts the flow, showing the code, link and steps", async () => {
    mockFetch({
      "GET /api/auth/me": signedOut(true),
      "POST /api/auth/device": { body: started },
      "POST /api/auth/device/poll": pending(),
    });
    renderApp();
    await begin();
    expect(screen.getByText(copy.auth.ghCliCommand)).toBeInTheDocument();
    expect(screen.getByText("WDJB-MJHT")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    const link = screen.getByRole("link", { name: new RegExp(text.openLink) });
    expect(link).toHaveAttribute("href", started.verificationUri);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByText(text.waiting)).toHaveAttribute("aria-live", "polite");
  });

  it("announces Copied after copying, then clears it, and tolerates a clipboard failure", async () => {
    mockFetch({
      "GET /api/auth/me": signedOut(true),
      "POST /api/auth/device": { body: started },
      "POST /api/auth/device/poll": pending(),
    });
    renderApp();
    await begin();
    const write = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: write } });
    await press(screen.getByRole("button", { name: text.copy }));
    await tick(0);
    expect(write).toHaveBeenCalledWith("WDJB-MJHT");
    expect(screen.getByRole("status")).toHaveTextContent(text.copied);
    await press(screen.getByRole("button", { name: text.copy }));
    await tick(0);
    await tick(3000);
    expect(screen.getByRole("status")).toBeEmptyDOMElement();

    write.mockRejectedValue(new Error("denied"));
    await press(screen.getByRole("button", { name: text.copy }));
    await tick(0);
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });

  it("polls at the interval and never sooner, following a larger interval from the server", async () => {
    const replies = [pending(10), pending(10)];
    const fetchMock = mockFetch({
      "GET /api/auth/me": signedOut(true),
      "POST /api/auth/device": { body: started },
      "POST /api/auth/device/poll": () => replies.shift() ?? pending(10),
    });
    renderApp();
    await begin();
    await tick(4900);
    expect(pollCount(fetchMock)).toBe(0);
    await tick(100);
    expect(pollCount(fetchMock)).toBe(1);
    await tick(9900);
    expect(pollCount(fetchMock)).toBe(1);
    await tick(100);
    expect(pollCount(fetchMock)).toBe(2);
  });

  it("falls back to a one second floor for an unusable interval", async () => {
    const fetchMock = mockFetch({
      "GET /api/auth/me": signedOut(true),
      "POST /api/auth/device": { body: { ...started, interval: 0 } },
      "POST /api/auth/device/poll": pending(Number.NaN),
    });
    renderApp();
    await begin();
    await tick(999);
    expect(pollCount(fetchMock)).toBe(0);
    await tick(1);
    expect(pollCount(fetchMock)).toBe(1);
  });

  it("refetches the signed-in user when GitHub grants access, and stops polling", async () => {
    let granted = false;
    const fetchMock = mockFetch({
      "GET /api/auth/me": () =>
        granted
          ? { body: { mode: "gh-cli", user: { login: "ada", avatarUrl: "" }, error: null, deviceFlow: true, source: "device" } }
          : signedOut(true),
      "GET /api/repos": { body: [] },
      "POST /api/auth/device": { body: started },
      "POST /api/auth/device/poll": () => {
        granted = true;
        return { body: { status: "granted", interval: 5, user: { login: "ada", avatarUrl: "" } } };
      },
    });
    renderApp();
    await begin();
    await tick(5000);
    await tick(100);
    expect(screen.getByText("ada")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: copy.auth.signOut })).toBeInTheDocument();
    await tick(30000);
    expect(pollCount(fetchMock)).toBe(1);
  });

  it.each([
    ["expired", text.expired],
    ["denied", text.denied],
  ])("shows a plain message when the status is %s and starts again on retry", async (status, message) => {
    const starts: string[] = [];
    const fetchMock = mockFetch({
      "GET /api/auth/me": signedOut(true),
      "POST /api/auth/device": () => {
        starts.push("x");
        return { body: { ...started, userCode: `CODE-000${starts.length}` } };
      },
      "POST /api/auth/device/poll": () => ({ body: { status, interval: 5 } }),
    });
    renderApp();
    await begin();
    await tick(5000);
    expect(screen.getByText(message)).toBeInTheDocument();
    expect(pollCount(fetchMock)).toBe(1);
    await tick(20000);
    expect(pollCount(fetchMock)).toBe(1);

    await press(screen.getByRole("button", { name: text.tryAgain }));
    await tick(0);
    expect(screen.getByText("CODE-0002")).toBeInTheDocument();
    await tick(5000);
    expect(pollCount(fetchMock)).toBe(2);
  });

  it("shows the error and offers a retry when starting fails, and when a poll fails", async () => {
    let failStart = true;
    mockFetch({
      "GET /api/auth/me": signedOut(true),
      "POST /api/auth/device": () => (failStart ? { status: 502, body: { error: "GitHub is unreachable" } } : { body: started }),
      "POST /api/auth/device/poll": { status: 400, body: { error: "Poll failed" } },
    });
    renderApp();
    await begin();
    expect(screen.getByRole("alert")).toHaveTextContent("GitHub is unreachable");

    failStart = false;
    await press(screen.getByRole("button", { name: text.tryAgain }));
    await tick(0);
    await tick(5000);
    expect(screen.getByRole("alert")).toHaveTextContent("Poll failed");
    expect(screen.getByRole("button", { name: text.tryAgain })).toBeInTheDocument();
  });

  it("stops polling when unmounted, including a poll already in flight", async () => {
    const fetchMock = mockFetch({
      "GET /api/auth/me": signedOut(true),
      "POST /api/auth/device": { body: started },
      "POST /api/auth/device/poll": pending(),
    });
    const { unmount } = renderApp();
    await begin();
    await tick(5000);
    expect(pollCount(fetchMock)).toBe(1);
    unmount();
    await tick(60000);
    expect(pollCount(fetchMock)).toBe(1);
  });

  it("ignores a poll answer that lands after unmount", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const fetchMock = mockFetch({
      "GET /api/auth/me": signedOut(true),
      "POST /api/auth/device": { body: started },
      "POST /api/auth/device/poll": async () => {
        await gate;
        return pending();
      },
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { unmount } = renderApp();
    await begin();
    await tick(5000);
    expect(pollCount(fetchMock)).toBe(1);
    unmount();
    release();
    await tick(60000);
    expect(pollCount(fetchMock)).toBe(1);
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("keeps polling through transient failures and resets the count after a good poll", async () => {
    const replies: MockResponse[] = [
      { status: 503, body: { error: "down" } },
      { status: 500, body: { error: "down" } },
      pending(),
      { status: 502, body: { error: "down" } },
      { status: 502, body: { error: "down" } },
    ];
    const fetchMock = mockFetch({
      "GET /api/auth/me": signedOut(true),
      "POST /api/auth/device": { body: started },
      "POST /api/auth/device/poll": () => replies.shift() ?? pending(),
    });
    renderApp();
    await begin();
    await tick(5000 * 5);
    expect(pollCount(fetchMock)).toBe(5);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText(text.waiting)).toBeInTheDocument();
  });

  it("shows the error after three consecutive transient failures, and a network error counts", async () => {
    const fetchMock = mockFetch({
      "GET /api/auth/me": signedOut(true),
      "POST /api/auth/device": { body: started },
      "POST /api/auth/device/poll": { status: 503, body: { error: "Still down" } },
    });
    renderApp();
    await begin();
    await tick(5000 * 3);
    expect(pollCount(fetchMock)).toBe(3);
    expect(screen.getByRole("alert")).toHaveTextContent("Still down");
    expect(screen.getByRole("button", { name: text.tryAgain })).toBeInTheDocument();
    await tick(30000);
    expect(pollCount(fetchMock)).toBe(3);
  });

  it("treats a network failure as transient", async () => {
    let calls = 0;
    mockFetch({
      "GET /api/auth/me": signedOut(true),
      "POST /api/auth/device": { body: started },
      "POST /api/auth/device/poll": () => {
        calls += 1;
        if (calls === 1) throw new TypeError("offline");
        return pending();
      },
    });
    renderApp();
    await begin();
    await tick(10000);
    expect(calls).toBe(2);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each([429, 403])("shows the error and retry when starting is refused with %s", async (status) => {
    mockFetch({
      "GET /api/auth/me": signedOut(true),
      "POST /api/auth/device": { status, body: { error: `Refused ${status}` } },
    });
    renderApp();
    await begin();
    expect(screen.getByRole("alert")).toHaveTextContent(`Refused ${status}`);
    expect(screen.getByRole("button", { name: text.tryAgain })).toBeInTheDocument();
  });

  it("stops at once on a client error from a poll", async () => {
    const fetchMock = mockFetch({
      "GET /api/auth/me": signedOut(true),
      "POST /api/auth/device": { body: started },
      "POST /api/auth/device/poll": { status: 400, body: { error: "Bad request" } },
    });
    renderApp();
    await begin();
    await tick(5000);
    expect(screen.getByRole("alert")).toHaveTextContent("Bad request");
    await tick(30000);
    expect(pollCount(fetchMock)).toBe(1);
  });

  it("explains when GitHub granted access but the session still has no user", async () => {
    const fetchMock = mockFetch({
      "GET /api/auth/me": signedOut(true),
      "POST /api/auth/device": { body: started },
      "POST /api/auth/device/poll": { body: { status: "granted", interval: 5, user: { login: "ada", avatarUrl: "" } } },
    });
    renderApp();
    await begin();
    await tick(5000);
    await tick(100);
    expect(screen.getByRole("alert")).toHaveTextContent(text.incomplete);
    expect(screen.getByRole("button", { name: text.tryAgain })).toBeInTheDocument();
    await tick(30000);
    expect(pollCount(fetchMock)).toBe(1);
  });

  it.each([
    ["device", "gh-cli", true, true],
    ["oauth", "oauth", false, true],
    ["cli", "gh-cli", true, false],
    [undefined, "oauth", false, true],
    [undefined, "gh-cli", true, false],
  ] as const)("sign out for source %s in %s mode is shown: %s", async (source, mode, deviceFlow, shown) => {
    mockFetch({
      "GET /api/auth/me": {
        body: { mode, user: { login: "ada", avatarUrl: "" }, error: null, deviceFlow, ...(source ? { source } : {}) },
      },
      "GET /api/repos": { body: [] },
    });
    renderApp();
    await tick(0);
    expect(screen.getByText("ada")).toBeInTheDocument();
    const button = screen.queryByRole("button", { name: copy.auth.signOut });
    if (shown) expect(button).toBeInTheDocument();
    else expect(button).not.toBeInTheDocument();
  });
});
