/**
 * The name the browser offers when a report is saved as a PDF, taken from the document title.
 * Lower case, with anything other than letters and digits collapsed to single hyphens,
 * for example "acme-widgets-delivery-report-2026-09-29". The label names the kind of report.
 */
export function reportFileName(subject: string, day: string, label = "delivery report"): string {
  return [subject, label, day]
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
