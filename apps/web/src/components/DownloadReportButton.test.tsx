import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DownloadReportButton } from "./DownloadReportButton";
import { copy } from "../copy";
import { formatDate } from "../lib/format";

const now = new Date("2026-09-29T10:00:00Z");

afterEach(() => {
  document.title = "";
  delete document.documentElement.dataset.theme;
  document.documentElement.classList.remove("is-printing");
});

describe("DownloadReportButton", () => {
  it("prints at the print width in the light theme under a file name for the subject, then restores the page", async () => {
    const user = userEvent.setup();
    document.title = "Delivery Metrics";
    document.documentElement.dataset.theme = "dark";
    const seen: { title: string; theme: string | undefined; printing: boolean }[] = [];
    vi.spyOn(window, "print").mockImplementation(() => {
      const root = document.documentElement;
      seen.push({ title: document.title, theme: root.dataset.theme, printing: root.classList.contains("is-printing") });
      window.dispatchEvent(new Event("afterprint"));
    });

    render(<DownloadReportButton subject="acme/widgets" now={now} />);
    await user.click(screen.getByRole("button", { name: copy.report.download }));

    await waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toEqual({ title: "acme-widgets-delivery-report-2026-09-29", theme: "light", printing: true });
    expect(document.title).toBe("Delivery Metrics");
    expect(document.documentElement).not.toHaveClass("is-printing");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("leaves no theme set afterwards when the page was following the system theme", async () => {
    const user = userEvent.setup();
    const print = vi.spyOn(window, "print").mockImplementation(() => window.dispatchEvent(new Event("afterprint")));

    render(<DownloadReportButton subject="acme/widgets" now={now} />);
    await user.click(screen.getByRole("button", { name: copy.report.download }));
    await waitFor(() => expect(print).toHaveBeenCalled());

    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it("carries the preparation date for the printed copy", () => {
    render(<DownloadReportButton subject="acme/widgets" now={now} />);
    expect(screen.getByText(copy.report.prepared(formatDate("2026-09-29")))).toBeInTheDocument();
  });
});
