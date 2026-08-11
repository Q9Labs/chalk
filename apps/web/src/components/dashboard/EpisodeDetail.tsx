import { formatDateTime, formatJSON, humanizeReason, statusLabel } from "./episode-utils";
import type { DashboardEpisode } from "../../lib/dashboard-api";
import { EpisodeDiagnosticsDeveloperLink, type EpisodeDiagnosticsAvailabilityClient } from "../../features/episode-debugger/EpisodeDiagnosticsDeveloperLink";
import { defaultSpaceHrefBuilder, type SpaceHrefBuilder } from "./space-links";

export type EpisodeDetailLoadState = "idle" | "loading" | "ready" | "error";

export function EpisodeDetailPanel({
  episode,
  spaceName,
  spaceSlug,
  spaceArchived = false,
  spaceHrefBuilder = defaultSpaceHrefBuilder,
  state,
  error,
  onRetry,
  onClose,
  onEnd,
  diagnosticsApi,
}: {
  episode: DashboardEpisode | null;
  spaceName?: string;
  spaceSlug?: string;
  spaceArchived?: boolean;
  spaceHrefBuilder?: SpaceHrefBuilder;
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
          {spaceSlug ? <code className="episode-detail-space-slug">{spaceSlug}</code> : null}
        </div>
        <div className="episode-detail-heading-actions">
          {spaceSlug && !spaceArchived ? (
            <a className="dashboard-button primary episode-detail-open-space" href={spaceHrefBuilder({ slug: spaceSlug })}>
              Join Space
            </a>
          ) : null}
          <button className="episode-detail-close" type="button" aria-label="Close Episode details" onClick={onClose}>
            ×
          </button>
        </div>
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
          <div>
            <p className="eyebrow">Frozen at start</p>
            <h3>Configuration snapshot</h3>
          </div>
          <span>Read-only</span>
        </div>
        <SnapshotOverview value={episode.config_snapshot} />
        <details className="episode-raw-details">
          <summary>View raw configuration</summary>
          <pre>{formatJSON(episode.config_snapshot)}</pre>
        </details>
      </section>
      <details className="episode-advanced-section">
        <summary>Advanced details</summary>
        <section className="episode-snapshot-section">
          <div className="episode-section-heading">
            <h3>Metadata</h3>
            <span>Read-only</span>
          </div>
          <pre>{formatJSON(episode.metadata)}</pre>
        </section>
        <div className="episode-detail-diagnostics">
          <span>
            <strong>Developer diagnostics</strong>
            <small>Inspect the live evidence recorded for this Episode.</small>
          </span>
          <EpisodeDiagnosticsDeveloperLink diagnosticReference={`chalk.episode:${episode.id}`} api={diagnosticsApi} />
        </div>
      </details>
    </>
  );
}

function SnapshotOverview({ value }: { value: unknown }) {
  const entries = value && typeof value === "object" && !Array.isArray(value) ? Object.entries(value as Record<string, unknown>) : [];
  if (entries.length === 0) return <p className="episode-contract-note">No configuration values were recorded for this Episode.</p>;
  return (
    <dl className="episode-snapshot-grid">
      {entries.map(([key, item]) => (
        <div key={key}>
          <dt>{humanizeKey(key)}</dt>
          <dd>{formatSnapshotValue(key, item)}</dd>
        </div>
      ))}
    </dl>
  );
}

function humanizeKey(key: string): string {
  const label = key.replace(/_seconds$/, "").replaceAll("_", " ");
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function formatSnapshotValue(key: string, value: unknown): string {
  if (value === null || value === undefined || value === "") return "Not set";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number" && key.endsWith("_seconds")) return formatSeconds(value);
  if (key === "media_plane" && value === "cf_rtk") return "Cloudflare RealtimeKit";
  if (typeof value === "string" || typeof value === "number") return String(value).replaceAll("_", " ");
  return JSON.stringify(value);
}

function formatSeconds(value: number): string {
  if (value >= 86_400 && value % 86_400 === 0) return unit(value / 86_400, "day");
  if (value >= 3_600 && value % 3_600 === 0) return unit(value / 3_600, "hour");
  if (value >= 60 && value % 60 === 0) return unit(value / 60, "minute");
  return unit(value, "second");
}

function unit(value: number, label: string): string {
  return `${value} ${label}${value === 1 ? "" : "s"}`;
}
