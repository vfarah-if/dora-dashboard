import { useState } from "react";
import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SecuritySection } from "./SecuritySection";
import { mockFetch, renderRoute, type MockResponse } from "../test/render";
import { errorSource, securityReport } from "../test/fixtures";
import { copy } from "../copy";

function WithRangeButton() {
  const [to, setTo] = useState("2026-03-01");
  return (
    <>
      <button type="button" onClick={() => setTo("2026-02-01")}>
        Change range
      </button>
      <SecuritySection repoId={1} range={{ from: "2026-01-01", to, includeBots: false }} />
    </>
  );
}

describe("SecuritySection", () => {
  it("names a source that failed, with when it last worked, so the summary is not taken for a fresh read", async () => {
    const base = securityReport();
    mockFetch({
      "GET /api/repos/1/security": {
        body: securityReport({
          sources: {
            ...base.sources,
            dependabot: errorSource("down", { readAt: "2026-02-10T08:00:00Z", truncated: false, skipped: 0 }),
          },
        }),
      },
    });
    renderRoute(<SecuritySection repoId={1} range={{ from: null, to: null, includeBots: false }} />);
    const notice = (await screen.findByText(copy.security.failedSources.title)).closest("aside")!;
    expect(notice).toHaveTextContent("Dependabot alerts, last read on 10 Feb 2026, 08:00");
    // The sources panel is on the detail page, so the link goes there and not to an anchor that is not here.
    expect(within(notice).getByRole("link", { name: copy.security.failedSources.link })).toHaveAttribute(
      "href",
      "/repos/1/security#security-sources",
    );
    expect(notice).not.toHaveAttribute("role");
  });

  it("says nothing of failures when every source answered", async () => {
    mockFetch({ "GET /api/repos/1/security": { body: securityReport() } });
    renderRoute(<SecuritySection repoId={1} range={{ from: null, to: null, includeBots: false }} />);
    await screen.findByRole("link", { name: copy.security.section.detail });
    expect(screen.queryByText(copy.security.failedSources.title)).not.toBeInTheDocument();
  });

  it("keeps the earlier figures on screen but marks them as refreshing until the new range arrives", async () => {
    const user = userEvent.setup();
    let release: (response: MockResponse) => void = () => undefined;
    mockFetch({
      "GET /api/repos/1/security": (url) =>
        url.searchParams.get("to") === "2026-03-01"
          ? { body: securityReport() }
          : new Promise<MockResponse>((resolve) => (release = resolve)),
    });
    renderRoute(<WithRangeButton />);
    const detail = await screen.findByRole("link", { name: copy.security.section.detail });
    const wrapper = detail.closest("[aria-busy]")!;
    expect(wrapper).toHaveAttribute("aria-busy", "false");
    expect(wrapper).not.toHaveClass("is-refreshing");

    await user.click(screen.getByRole("button", { name: "Change range" }));

    await waitFor(() => expect(wrapper).toHaveAttribute("aria-busy", "true"));
    expect(wrapper).toHaveClass("is-refreshing");
    expect(screen.getByRole("link", { name: copy.security.section.detail })).toBeInTheDocument();
    release({ body: securityReport() });
    await waitFor(() => expect(wrapper).toHaveAttribute("aria-busy", "false"));
    expect(wrapper).not.toHaveClass("is-refreshing");
  });
});
