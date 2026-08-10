import { formatDateTime, formatJSON, humanizeReason, statusLabel } from "./episode-utils";
import type { DashboardEpisode } from "../../lib/dashboard-api";
import { EpisodeDiagnosticsDeveloperLink, type EpisodeDiagnosticsAvailabilityClient } from "../../features/episode-debugger/EpisodeDiagnosticsDeveloperLink";

export type EpisodeDetailLoadState = "idle" | "loading" | "ready" | "error";

export function EpisodeDetailPanel({
  episode,
  spaceName,
  state,
  error,
  onRetry,
  onClose,
  onEnd,
  diagnosticsApi,
}: {
  episode: DashboardEpisode | null;
  spaceName?: string;
  state: EpisodeDetailLoadState;
  error: string | null;
  onRetry: () => void;
  onClose: () => void;
  onEnd: () => void;
  diagnosticsApi?: EpisodeDiagnosticsAvailabilityClient;
}) {
  return (
    <aside className="episode-detail-panel" aria-label="Episode details">
      <div className="episode-detail-heading">
        <div>
          <p className="eyebrow">Episode detail</p>
          <h2>{spaceName ?? "Space"}</h2>
        </div>
        <button className="episode-detail-close" type="button" aria-label="Close Episode details" onClick={onClose}>
          ×
        </button>
      </div>
      {state === "loading" ? (
        <p className="episode-detail-loading" aria-live="polite">
          Loading the immutable snapshot…
        </p>
      ) : null}
      {state === "error" ? (
        <div className="episode-detail-error" role="alert">
          <p>{error ?? "Episode details could not load"}</p>
          <button className="dashboard-button secondary" type="button" onClick={onRetry}>
            Try again
          </button>
        </div>
      ) : null}
      {state === "ready" && episode ? <EpisodeDetailContent episode={episode} onEnd={onEnd} diagnosticsApi={diagnosticsApi} /> : null}
    </aside>
  );
}

function EpisodeDetailContent({ episode, onEnd, diagnosticsApi }: { episode: DashboardEpisode; onEnd: () => void; diagnosticsApi?: EpisodeDiagnosticsAvailabilityClient }) {
  const ended = episode.status === "ended";
  return (
    <>
      <div className="episode-detail-status-row">
        <span className={`episode-status-chip episode-status-chip-${episode.status}`}>
          <span aria-hidden="true" />
          {statusLabel(episode.status)}
        </span>
        {ended ? (
          <span className="episode-immutable-label">Immutable history</span>
        ) : (
          <button className="dashboard-button secondary episode-end-button" type="button" onClick={onEnd}>
            End Episode
          </button>
        )}
      </div>
      <div className="episode-detail-diagnostics">
        <EpisodeDiagnosticsDeveloperLink diagnosticReference={`chalk.episode:${episode.id}`} api={diagnosticsApi} />
      </div>
      <dl className="episode-detail-meta">
        <div>
          <dt>Started</dt>
          <dd>{formatDateTime(episode.started_at)}</dd>
        </div>
        <div>
          <dt>{ended ? "Ended" : "Deadline"}</dt>
          <dd>{formatDateTime(ended ? episode.ended_at : episode.deadline_at)}</dd>
        </div>
        {episode.end_reason ? (
          <div>
            <dt>End reason</dt>
            <dd>{humanizeReason(episode.end_reason)}</dd>
          </div>
        ) : null}
      </dl>
      <section className="episode-snapshot-section">
        <div className="episode-section-heading">
          <h3>Config snapshot</h3>
          <span>Frozen at start</span>
        </div>
        <pre>{formatJSON(episode.config_snapshot)}</pre>
      </section>
      <section className="episode-snapshot-section">
        <div className="episode-section-heading">
          <h3>Metadata</h3>
          <span>Read-only</span>
        </div>
        <pre>{formatJSON(episode.metadata)}</pre>
      </section>
      <p className="episode-contract-note">Attendance and Artifacts stay read-only too. Their detailed projections will appear when those read contracts are available.</p>
    </>
  );
}
