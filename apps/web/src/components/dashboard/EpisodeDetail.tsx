import { formatDateTime, formatJSON, humanizeReason, statusLabel } from "./episode-utils";
import type { DashboardEpisode } from "../../lib/dashboard-api";
import { EpisodeDiagnosticsDeveloperLink, type EpisodeDiagnosticsAvailabilityClient, useEpisodeDiagnosticsAvailability } from "../../features/episode-debugger/EpisodeDiagnosticsDeveloperLink";
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
  const diagnostics = useEpisodeDiagnosticsAvailability({ diagnosticReference: episode ? `chalk.episode:${episode.id}` : undefined, api: diagnosticsApi });

  return (
    <aside className="episode-detail-panel" aria-label="Episode details">
      <div className="episode-detail-heading">
        <div>
          <h2>Episode details</h2>
          <h3 className="sr-only">{spaceName ?? "Space"}</h3>
          {episode ? <code className="episode-detail-episode-id">{episode.id}</code> : null}
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
      {state === "ready" && episode ? <EpisodeDetailContent episode={episode} spaceName={spaceName} spaceSlug={spaceSlug} spaceArchived={spaceArchived} spaceHrefBuilder={spaceHrefBuilder} onEnd={onEnd} diagnosticsApi={diagnosticsApi} diagnostics={diagnostics} /> : null}
    </aside>
  );
}

function EpisodeDetailContent({
  episode,
  spaceName,
  spaceSlug,
  spaceArchived,
  spaceHrefBuilder,
  onEnd,
  diagnosticsApi,
  diagnostics,
}: {
  episode: DashboardEpisode;
  spaceName?: string;
  spaceSlug?: string;
  spaceArchived: boolean;
  spaceHrefBuilder: SpaceHrefBuilder;
  onEnd: () => void;
  diagnosticsApi?: EpisodeDiagnosticsAvailabilityClient;
  diagnostics: ReturnType<typeof useEpisodeDiagnosticsAvailability>;
}) {
  const ended = episode.status === "ended";
  return (
    <>
      <section className="episode-detail-summary" aria-label="Episode summary">
        <div className="episode-detail-summary-heading">
          <span className="episode-detail-summary-icon" aria-hidden="true">
            ⌁
          </span>
          <div>
            <strong>{episode.id}</strong>
            <span className={`episode-status-chip episode-status-chip-${episode.status}`}>
              <span aria-hidden="true" />
              {statusLabel(episode.status)}
            </span>
            <p>{spaceName ?? "Space"}</p>
            {spaceSlug ? <code className="episode-detail-space-slug">{spaceSlug}</code> : null}
            <small>Started {formatDateTime(episode.started_at)}</small>
          </div>
        </div>
        <div className="episode-detail-primary-actions">
          <EpisodeDebuggerAction diagnostics={diagnostics} />
          {spaceSlug && !spaceArchived ? (
            <a className="dashboard-button secondary episode-detail-open-space" href={spaceHrefBuilder({ slug: spaceSlug })}>
              Join Space
            </a>
          ) : null}
        </div>
      </section>

      <section className="episode-timeline" aria-labelledby="episode-timeline-title">
        <div className="episode-section-heading">
          <h3 id="episode-timeline-title">Timeline</h3>
          <span>{ended ? "Complete" : "Live"}</span>
        </div>
        <ol>
          <li>
            <span className="episode-timeline-marker episode-timeline-marker-start" aria-hidden="true">
              ▷
            </span>
            <div>
              <strong>Episode started</strong>
              <time dateTime={episode.started_at}>{formatTimelineTime(episode.started_at)}</time>
              <p>{spaceName ?? "Space"} Episode began</p>
            </div>
          </li>
          <li>
            <span className={`episode-timeline-marker ${ended ? "episode-timeline-marker-end" : "episode-timeline-marker-deadline"}`} aria-hidden="true">
              {ended ? "✓" : "◷"}
            </span>
            <div>
              <strong>
                {ended ? "Episode ended" : "Episode deadline"}
                <span className="sr-only">{ended ? "Ended" : "Deadline"}</span>
              </strong>
              <time dateTime={(ended ? episode.ended_at : episode.deadline_at) ?? undefined}>{formatTimelineTime(ended ? episode.ended_at : episode.deadline_at)}</time>
              <p>{ended ? (episode.end_reason ? humanizeReason(episode.end_reason) : "Episode completed") : "The Episode remains live until this deadline."}</p>
            </div>
          </li>
        </ol>
      </section>

      <details className="episode-configuration-section">
        <summary>
          <span>
            <strong>Configuration</strong>
            <small>Configuration snapshot · Read-only</small>
          </span>
          <span aria-hidden="true">⌄</span>
        </summary>
        <section className="episode-snapshot-section">
          <SnapshotOverview value={episode.config_snapshot} />
          <details className="episode-raw-details">
            <summary>View raw configuration</summary>
            <pre>{formatJSON(episode.config_snapshot)}</pre>
          </details>
        </section>
      </details>

      <div className="episode-detail-status-row">
        {ended ? (
          <span className="episode-immutable-label">Immutable history</span>
        ) : (
          <button className="dashboard-button secondary episode-end-button" type="button" onClick={onEnd}>
            End Episode
          </button>
        )}
      </div>
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

function EpisodeDebuggerAction({ diagnostics }: { diagnostics: ReturnType<typeof useEpisodeDiagnosticsAvailability> }) {
  if (diagnostics.path) {
    return (
      <a className="dashboard-button primary episode-debugger-action" href={diagnostics.path}>
        Open debugger
      </a>
    );
  }
  return null;
}

function formatTimelineTime(value: string | null | undefined): string {
  if (!value) return "Not recorded";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Unknown time";
  return new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(date);
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
