import type { ReactNode } from "react";
import { copy } from "../copy";
import { errorText } from "../api/client";

export function Skeleton({ height = 120, label }: { height?: number; label?: string }) {
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

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div className="notice notice-error" role="alert">
      <p className="notice-title">{copy.common.errorTitle}</p>
      <p>{errorText(error)}</p>
      {onRetry && (
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
