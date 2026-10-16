import type { ReactNode } from "react";
import { copy } from "../copy";
import { canRetry, errorText } from "../api/client";

/**
 * A loading placeholder announced politely. `decorative` leaves it out of what a screen reader is told, for a second
 * placeholder beside one that already announces the loading, so the message is not read twice.
 */
export function Skeleton({ height = 120, label, decorative = false }: { height?: number; label?: string; decorative?: boolean }) {
  if (decorative) return <div className="skeleton" style={{ height }} aria-hidden="true" />;
  return (
    <div className="skeleton" style={{ height }} role="status" aria-live="polite">
      <span className="visually-hidden">{label ?? copy.common.loading}</span>
    </div>
  );
}

export function SkeletonGrid({ count, height = 120, label }: { count: number; height?: number; label?: string }) {
  return (
    <div className="tile-grid" role="status" aria-live="polite">
      <span className="visually-hidden">{label ?? copy.common.loading}</span>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="skeleton" style={{ height }} aria-hidden="true" />
      ))}
    </div>
  );
}

/** `message` replaces the text taken from `error`, for a failure whose own text is not fit to show. */
export function ErrorState({ error, onRetry, message }: { error: unknown; onRetry?: () => void; message?: string }) {
  return (
    <div className="notice notice-error" role="alert">
      <p className="notice-title">{copy.common.errorTitle}</p>
      <p>{message ?? errorText(error)}</p>
      {onRetry && canRetry(error) && (
        <button type="button" className="button button-secondary" onClick={onRetry}>
          {copy.common.retry}
        </button>
      )}
    </div>
  );
}

export function EmptyState({ title, children }: { title?: string; children?: ReactNode }) {
  return (
    <div className="empty-state">
      <p className="empty-title">{title ?? copy.states.emptyTitle}</p>
      {children && <div className="empty-body">{children}</div>}
    </div>
  );
}
