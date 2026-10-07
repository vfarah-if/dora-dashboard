import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { LIST_LIMIT } from "../lib/space";
import { GroupedItemList, HygieneLine, PullRequestList } from "./HygieneLists";

const item = (n: number, assignee: string | null) => ({ n, assigned: assignee !== null, assignee });

function renderList(items: ReturnType<typeof item>[], people: boolean) {
  render(
    <GroupedItemList
      items={items}
      people={people}
      itemKey={(i) => i.n}
      renderItem={(i) => <HygieneLine href={`https://example.test/${i.n}`} label={`#${i.n}`} summary={`Item ${i.n}`} />}
    />,
  );
}

describe("GroupedItemList", () => {
  it("shows one flat list without names when people are hidden", () => {
    renderList([item(1, "Ada"), item(2, null)], false);
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.queryByRole("heading", { name: "Ada" })).toBeNull();
  });

  it("groups under each assignee when people are shown", () => {
    renderList([item(1, "Ada"), item(2, "Ada"), item(3, "Grace")], true);
    expect(screen.getByRole("heading", { name: "Ada" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Grace" })).toBeInTheDocument();
  });

  it("offers the rest of a long list behind a button", async () => {
    renderList(
      Array.from({ length: LIST_LIMIT + 3 }, (_, i) => item(i + 1, null)),
      false,
    );
    expect(screen.getAllByRole("listitem")).toHaveLength(LIST_LIMIT);
    await userEvent.click(screen.getByRole("button"));
    expect(screen.getAllByRole("listitem")).toHaveLength(LIST_LIMIT + 3);
  });
});

describe("PullRequestList", () => {
  it("links each pull request by its qualified reference", () => {
    render(
      <PullRequestList pullRequests={[{ repo: "acme/widgets", number: 7, title: "Fix it", url: "https://example.test/pr/7" }]} />,
    );
    expect(screen.getByRole("link", { name: /acme\/widgets#7/ })).toHaveAttribute("href", "https://example.test/pr/7");
    expect(screen.getByText("Fix it")).toBeInTheDocument();
  });
});
