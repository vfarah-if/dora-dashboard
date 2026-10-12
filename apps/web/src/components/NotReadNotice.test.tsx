import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { copy } from "../copy";
import { errorSource, noAccessSource, noSecurity, offSource } from "../test/fixtures";
import { mockFetch, renderRoute } from "../test/render";
import { repo } from "../test/fixtures";
import { NotReadNotice } from "./NotReadNotice";

const text = copy.security.notRead;
const sourcesText = copy.security.sources;

const show = (sources: ReturnType<typeof noSecurity>["sources"], routes: Parameters<typeof mockFetch>[0] = {}) => {
  const fetchMock = mockFetch({ "GET /api/repos": { body: [repo()] }, ...routes });
  const view = renderRoute(<NotReadNotice repoId={1} sources={sources} />);
  return { ...view, fetchMock };
};
const failedDependabot = () => ({
  ...never,
  dependabot: errorSource("GitHub answered 502"),
  code_scanning: noAccessSource("forbidden"),
});
const never = noSecurity().sources;
const line = (name: string) => screen.getByText(name, { selector: "strong" }).closest("li")!;

describe("NotReadNotice", () => {
  it("says the repository has not been crawled, and offers a crawl, when no source has ever been attempted", () => {
    show(never);
    expect(screen.getByText(text.title)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: text.crawl })).toBeInTheDocument();
    expect(screen.queryByText(text.refused.title)).not.toBeInTheDocument();
  });

  it("says each source refused the credential, with why and what to do, and does not promise the next crawl", () => {
    show({
      ...never,
      dependabot: noAccessSource("forbidden"),
      code_scanning: noAccessSource("forbidden"),
      secret_scanning: noAccessSource("admin_only_or_off"),
    });
    expect(screen.getByText(text.refused.title)).toBeInTheDocument();
    expect(screen.queryByText(text.title)).not.toBeInTheDocument();
    expect(line("Dependabot alerts")).toHaveTextContent(sourcesText.reasons.forbidden);
    expect(line("Secret scanning")).toHaveTextContent(sourcesText.reasons.admin_only_or_off);
    expect(line("Secret scanning")).toHaveTextContent("only be read by a repository administrator");
    expect(document.body).not.toHaveTextContent(sourcesText.notYet);
    // Crawling cannot change a refusal, so no crawl is offered.
    expect(screen.queryByRole("button", { name: text.crawl })).not.toBeInTheDocument();
  });

  it("says each feature is switched off, with how to switch it on, when every source is off", () => {
    show({
      ...never,
      dependabot: offSource("disabled"),
      code_scanning: offSource("needs_advanced_security"),
      secret_scanning: offSource("not_set_up"),
    });
    expect(screen.getByText(text.refused.title)).toBeInTheDocument();
    expect(line("Dependabot alerts")).toHaveTextContent(sourcesText.reasons.disabled);
    expect(line("Dependabot alerts")).toHaveTextContent("switch on Dependabot alerts");
    expect(line("Code scanning")).toHaveTextContent("GitHub Code Security");
    expect(line("Secret scanning")).toHaveTextContent(sourcesText.reasons.not_set_up);
    expect(screen.queryByRole("button", { name: text.crawl })).not.toBeInTheDocument();
  });

  it("keeps not read yet for a source that really has not been read, beside one that failed, and offers a retry", () => {
    show({
      ...never,
      dependabot: errorSource("GitHub answered 502"),
      code_scanning: noAccessSource("forbidden"),
      secret_scanning: { status: "not_read" },
    });
    expect(line("Dependabot alerts")).toHaveTextContent('"GitHub answered 502"');
    expect(line("Dependabot alerts")).toHaveTextContent("There is no earlier read to fall back on.");
    // A failed source is not a switched-off one, so it is not told to switch the feature on.
    expect(line("Dependabot alerts")).not.toHaveTextContent("How to switch it on");
    expect(line("Dependabot alerts")).not.toHaveTextContent("Advanced Security");
    expect(line("Code scanning")).toHaveTextContent(sourcesText.reasons.forbidden);
    expect(within(line("Secret scanning")).getByText(sourcesText.notYet, { exact: false })).toBeInTheDocument();
    expect(screen.getByText(text.refused.retry)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: text.crawl })).toBeInTheDocument();
  });

  it("names the OSV lookup only when it failed, since it is optional", () => {
    const { unmount } = show({ ...never, dependabot: offSource(), osv: errorSource("OSV answered 500") });
    expect(line("OSV.dev lookup")).toHaveTextContent('"OSV answered 500"');
    unmount();
    show({ ...never, dependabot: offSource() });
    expect(screen.queryByText("OSV.dev lookup", { selector: "strong" })).not.toBeInTheDocument();
  });

  describe("retrying a failed read", () => {
    it("starts an incremental crawl, disables the button and announces that it is running", async () => {
      const user = userEvent.setup();
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => (release = resolve));
      const { fetchMock } = show(failedDependabot(), {
        "POST /api/repos/1/crawl": async () => {
          await held;
          return { status: 202, body: {} };
        },
      });
      const status = screen.getByRole("status");
      expect(status).toBeEmptyDOMElement();
      await user.click(screen.getByRole("button", { name: text.crawl }));
      const [path] = fetchMock.mock.calls.map(([input]) => String(input)).filter((url) => url.includes("/crawl"));
      expect(path).toBe("/api/repos/1/crawl");
      expect(await screen.findByRole("button", { name: text.crawling })).toBeDisabled();
      expect(within(screen.getByRole("status")).getByText(text.crawling)).toBeInTheDocument();
      release();
      await waitFor(() => expect(screen.getByRole("button", { name: text.crawl })).toBeEnabled());
    });

    it("says so when the crawl could not be started", async () => {
      const user = userEvent.setup();
      show(failedDependabot(), { "POST /api/repos/1/crawl": { status: 500, body: { error: "no" } } });
      await user.click(screen.getByRole("button", { name: text.crawl }));
      expect(await screen.findByText(text.failed)).toBeInTheDocument();
    });
  });

  it("keeps a status region in the page before any crawl in the first notice as well", () => {
    show(never);
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });
});
