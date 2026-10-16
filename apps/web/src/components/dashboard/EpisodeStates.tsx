import { openNewSpaceDialog } from "./DashboardShell";
import type { DashboardPagination } from "../../lib/dashboard-api";

export function EpisodeListLoading() {
  return (
    <section className="episode-list-panel episode-list-loading" aria-live="polite" aria-busy="true">
      <span className="sr-only">Loading Episodes…</span>
      <div className="episode-loading-row" />
      <div className="episode-loading-row" />
      <div className="episode-loading-row" />
    </section>
  );
}

export function EpisodeErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <section className="episode-state episode-state-error" role="alert">
      <h2>Episodes could not load.</h2>
      <p>{message}</p>
      <button className="dashboard-button secondary" type="button" onClick={onRetry}>
        Try again
      </button>
    </section>
  );
}

export function NoSpacesState() {
  return (
    <section className="episode-state episode-state-empty">
      <h2>No Spaces yet.</h2>
      <p>An Episode starts when someone joins a Space. Create a Space first.</p>
      <button className="dashboard-button primary" type="button" onClick={openNewSpaceDialog}>
        New Space
      </button>
    </section>
  );
}

export function EpisodeEmptyState({ filtered, onStart }: { filtered: boolean; onStart: () => void }) {
  return (
    <section className="episode-state episode-state-empty">
      <h2>{filtered ? "No Episodes match these filters." : "No Episodes yet."}</h2>
      <p>{filtered ? "Change the Space or status filter to see more." : "An Episode starts when someone joins a Space, and it appears here."}</p>
      {!filtered ? (
        <button className="dashboard-button secondary" type="button" onClick={onStart}>
          Start and join
        </button>
      ) : null}
    </section>
  );
}

export function EpisodePagination({ pagination, cursorHistory, onPrevious, onNext }: { pagination: DashboardPagination | null; cursorHistory: string[]; onPrevious: () => void; onNext: () => void }) {
  if (!pagination || (!pagination.has_more && cursorHistory.length === 0)) return null;
  return (
    <nav className="episode-pagination" aria-label="Episode history pages">
      <button className="dashboard-button secondary" type="button" onClick={onPrevious} disabled={cursorHistory.length === 0}>
        Previous
      </button>
      <span>Page {cursorHistory.length + 1}</span>
      <button className="dashboard-button secondary" type="button" onClick={onNext} disabled={!pagination.has_more}>
        Next
      </button>
    </nav>
  );
}
