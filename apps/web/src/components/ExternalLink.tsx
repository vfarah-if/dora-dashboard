import { copy } from "../copy";

/** A link that opens in a new tab, with the destination announced to screen readers. */
export function ExternalLink({ href, children, className }: { href: string; children: string; className?: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className={className}>
      {children}
      <span className="visually-hidden"> {copy.common.opensInNewTab}</span>
    </a>
  );
}
