import { describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DoraTile } from "./DoraTile";
import { copy } from "../copy";
import type { DoraExplanation } from "../lib/doraExplain";

describe("DoraTile", () => {
  it("prints the band as text beside the figure so band never relies on colour", () => {
    render(
      <DoraTile
        title={copy.dora.leadTime}
        definition={copy.dora.leadTimeDefinition}
        value="1.3 days"
        band="elite"
        detail="Across 4 shipped pull requests"
      />,
    );
    expect(screen.getByRole("heading", { name: copy.dora.leadTime })).toBeInTheDocument();
    expect(screen.getByText("1.3 days")).toBeInTheDocument();
    expect(screen.getByText("Elite")).toBeInTheDocument();
    expect(screen.getByText(copy.dora.leadTimeDefinition)).toBeInTheDocument();
  });

  it("explains the missing band instead of showing one", () => {
    render(
      <DoraTile
        title={copy.dora.rework}
        definition={copy.dora.reworkDefinition}
        value="33%"
        band={null}
        detail={copy.dora.reworkCount(1, 3)}
        noBandNote={copy.dora.reworkNoBand}
      />,
    );
    expect(screen.getByText("33%")).toBeInTheDocument();
    expect(screen.getByText(copy.dora.reworkNoBand)).toBeInTheDocument();
    expect(screen.getByText("1 of 3 deploys shipped a revert or hotfix")).toBeInTheDocument();
  });

  it("says Not measured with the reason when the figure is missing", () => {
    render(
      <DoraTile
        title={copy.dora.deploymentFrequency}
        definition={copy.dora.deploymentFrequencyDefinition}
        value={null}
        band={null}
        reason={copy.dora.reasons.noWorkflow}
      />,
    );
    expect(screen.getByText(copy.dora.notMeasured)).toBeInTheDocument();
    expect(screen.getByText(copy.dora.reasons.noWorkflow)).toBeInTheDocument();
    expect(screen.queryByText(/Elite|High|Medium|Low/)).not.toBeInTheDocument();
  });

  describe("explanation", () => {
    const explanation: DoraExplanation = {
      meaning: "Meaning sentence.",
      source: { label: "Performance levels", href: "https://dora.dev/levels" },
      gap: "Gap sentence.",
      findings: ["First finding.", "Second finding."],
      practices: [{ name: "Small batches", url: "https://dora.dev/capabilities/small", why: "Because." }],
      quote: { text: "Quoted words.", label: "Executive summary", href: "https://dora.dev/review" },
      note: "Renamed note.",
    };
    const tile = (extra: Partial<DoraExplanation> | null = {}) => (
      <DoraTile
        title={copy.dora.leadTime}
        definition={copy.dora.leadTimeDefinition}
        value="30.0 h"
        band="high"
        explanation={extra === null ? undefined : { ...explanation, ...extra }}
      />
    );

    it("is closed until the summary is pressed, then shows every part", async () => {
      const user = userEvent.setup();
      const { container } = render(tile());
      const details = container.querySelector("details")!;
      expect(details).toHaveClass("table-disclosure");
      expect(details.open).toBe(false);
      await user.click(screen.getByText(copy.dora.explain.summary));
      expect(details.open).toBe(true);
      expect(screen.getByText(/Meaning sentence\./)).toBeInTheDocument();
      expect(screen.getByText("Renamed note.")).toBeInTheDocument();
      expect(screen.getByText("Gap sentence.")).toBeInTheDocument();
      expect(screen.getByText("First finding.")).toBeInTheDocument();
      expect(screen.getByText("Second finding.")).toBeInTheDocument();
      expect(screen.getByText("Quoted words.")).toBeInTheDocument();
      expect(screen.getByText(copy.dora.explain.systemNote)).toBeInTheDocument();
    });

    it("links to its sources and practices in a new tab", () => {
      render(tile());
      for (const [name, href] of [
        ["Performance levels", "https://dora.dev/levels"],
        ["Small batches", "https://dora.dev/capabilities/small"],
        ["Executive summary", "https://dora.dev/review"],
      ] as const) {
        const link = screen.getByRole("link", { name: new RegExp(name) });
        expect(link).toHaveAttribute("href", href);
        expect(link).toHaveAttribute("target", "_blank");
        expect(link).toHaveTextContent(copy.common.opensInNewTab);
      }
    });

    it("puts the summary in the tab order, so the browser opens it from the keyboard", async () => {
      const user = userEvent.setup();
      render(tile());
      await user.tab();
      expect(screen.getByText(copy.dora.explain.summary)).toHaveFocus();
    });

    it("leaves out the findings, quote, note and practices when there are none", () => {
      render(tile({ findings: [], practices: [], quote: null, note: null }));
      expect(screen.queryByText(copy.dora.explain.findingsHeading)).not.toBeInTheDocument();
      expect(screen.queryByText(copy.dora.explain.practicesHeading)).not.toBeInTheDocument();
      expect(screen.queryByText("Quoted words.")).not.toBeInTheDocument();
      expect(screen.queryByText("Renamed note.")).not.toBeInTheDocument();
    });

    it("has no disclosure without an explanation or without a figure", () => {
      const { container, rerender } = render(tile(null));
      expect(container.querySelector("details")).toBeNull();
      rerender(<DoraTile title="x" definition="y" value={null} band={null} explanation={explanation} />);
      expect(container.querySelector("details")).toBeNull();
    });

    it("opens for the printed copy and returns to how it was afterwards", () => {
      const { container } = render(tile());
      const details = container.querySelector("details")!;
      act(() => void window.dispatchEvent(new Event("beforeprint")));
      expect(details.open).toBe(true);
      act(() => void window.dispatchEvent(new Event("afterprint")));
      expect(details.open).toBe(false);
      details.open = true;
      act(() => void window.dispatchEvent(new Event("beforeprint")));
      act(() => void window.dispatchEvent(new Event("afterprint")));
      expect(details.open).toBe(true);
    });

    it("names its measure to assistive technology after the visible summary", () => {
      render(tile());
      const summary = screen.getByText(copy.dora.explain.summary).closest("summary")!;
      expect(summary).toHaveTextContent(copy.dora.explain.summary);
      expect(summary).toHaveAccessibleName(`${copy.dora.explain.summary}, ${copy.dora.leadTime}`);
      expect(within(summary).getByText(`, ${copy.dora.leadTime}`)).toHaveClass("visually-hidden");
    });

    it("closes again after printing even when the browser announces the print twice", () => {
      const { container } = render(tile());
      const details = container.querySelector("details")!;
      act(() => void window.dispatchEvent(new Event("beforeprint")));
      act(() => void window.dispatchEvent(new Event("beforeprint")));
      expect(details.open).toBe(true);
      act(() => void window.dispatchEvent(new Event("afterprint")));
      expect(details.open).toBe(false);
    });

    it("stops listening for print once removed", () => {
      const added = vi.spyOn(window, "addEventListener");
      const removed = vi.spyOn(window, "removeEventListener");
      const { unmount } = render(tile());
      const listener = (type: string) => added.mock.calls.find((c) => c[0] === type)?.[1];
      expect(listener("beforeprint")).toBeDefined();
      expect(listener("afterprint")).toBeDefined();
      unmount();
      // The very functions that were added are the ones taken away again.
      expect(removed).toHaveBeenCalledWith("beforeprint", listener("beforeprint"));
      expect(removed).toHaveBeenCalledWith("afterprint", listener("afterprint"));
      added.mockRestore();
      removed.mockRestore();
    });
  });
});
