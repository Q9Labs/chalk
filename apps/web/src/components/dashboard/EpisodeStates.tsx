import { Icon } from "./DashboardShell";
import type { DashboardPagination } from "../../lib/dashboard-api";

export function EpisodeListLoading() {
  return (
    <section className="episode-list-panel episode-list-loading" aria-live="polite" aria-busy="true">
      <div className="episode-list-heading">
        <span>Loading Episodes</span>
        <span>One moment</span>
      </div>
      <div className="episode-loading-row" />
      <div className="episode-loading-row" />
      <div className="episode-loading-row" />
    </section>
  );
}

export function EpisodeErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <section className="episode-state episode-state-error" role="alert">
      <span className="episode-state-icon" aria-hidden="true">
        <Icon name="activity" />
      </span>
      <p className="eyebrow">Could not load history</p>
      <h2>Episodes are temporarily unavailable.</h2>
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
      <span className="episode-state-icon" aria-hidden="true">
        <Icon name="spaces" />
      </span>
      <p className="eyebrow">No Spaces yet</p>
      <h2>Create a Space before starting an Episode.</h2>
      <p>Episodes belong to a Space and capture the configuration that was active when the run began.</p>
      <a className="dashboard-button primary" href="/spaces">
        Create a Space
      </a>
    </section>
  );
}

export function EpisodeEmptyState({ filtered, onStart }: { filtered: boolean; onStart: () => void }) {
  return (
    <section className="episode-state episode-state-empty">
      <span className="episode-state-icon" aria-hidden="true">
        <Icon name="episodes" />
      </span>
      <p className="eyebrow">{filtered ? "No matching history" : "No Episodes yet"}</p>
      <h2>{filtered ? "Try another filter." : "Your first Episode starts with a Space."}</h2>
      <p>{filtered ? "Nothing in the current history matches those filters. The Episode itself is never edited after it ends." : "Starting is optional—someone joining an authorized Space can begin an Episode automatically."}</p>
      {!filtered ? (
        <button className="dashboard-button secondary" type="button" onClick={onStart}>
          Start an Episode
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
