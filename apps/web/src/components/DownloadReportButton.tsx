import { copy } from "../copy";
import { formatDate, isoDaysAgo } from "../lib/format";
import { reportFileName } from "../lib/report";

/** Time for the charts to redraw at the print width before the dialog opens. */
export const PRINT_SETTLE_MS = 300;

export interface DownloadReportButtonProps {
  /** What the report covers, used in the suggested file name. */
  subject: string;
  /** Injected so the date can be tested against a fixed day. */
  now?: Date;
}

/**
 * Saves the current page as a PDF through the browser's print dialog, so charts stay vector and text stays
 * selectable without a PDF library. The print stylesheet in app.css strips the controls. Before the dialog
 * opens the page is narrowed to the A4 width so the charts can redraw to fit, and for the length of the
 * dialog it is forced to the light theme and the document title becomes the suggested file name.
 */
export function DownloadReportButton({ subject, now }: DownloadReportButtonProps) {
  const today = isoDaysAgo(0, now);

  const download = () => {
    const root = document.documentElement;
    const previousTheme = root.dataset.theme;
    const previousTitle = document.title;
    const restore = () => {
      root.classList.remove("is-printing");
      document.title = previousTitle;
      if (previousTheme === undefined) delete root.dataset.theme;
      else root.dataset.theme = previousTheme;
    };
    window.addEventListener("afterprint", restore, { once: true });
    root.classList.add("is-printing");
    root.dataset.theme = "light";
    document.title = reportFileName(subject, today);
    window.setTimeout(() => window.print(), PRINT_SETTLE_MS);
  };

  return (
    <div className="report-actions">
      <button type="button" className="button button-secondary report-download" onClick={download} title={copy.report.hint}>
        <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path
            d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 19h14"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        {copy.report.download}
      </button>
      <p className="print-only">{copy.report.prepared(formatDate(today))}</p>
    </div>
  );
}
