import { useEffect, useState } from "react";
import { DashboardAPIError, getSpace, listEpisodes, type DashboardEpisode, type DashboardEpisodePage, type Space } from "../../lib/dashboard-api";
import { EditSpaceDialog } from "./EditSpaceDialog";
import { SpaceLifecycleDialog } from "./SpaceLifecycleDialog";
import { episodeHistoryHref, defaultSpaceHrefBuilder } from "./space-links";
import { durationLabel as episodeDurationLabel, formatDateTime, formatJSON, statusLabel } from "./episode-utils";

export type SpaceDetailClient = {
  getSpace: (input: { tenantID: string; spaceID: string }) => Promise<Space>;
  listEpisodes: (input: { tenantID: string; spaceID?: string; pageSize?: number }) => Promise<DashboardEpisodePage>;
};

const defaultSpaceDetailClient: SpaceDetailClient = { getSpace, listEpisodes };

type SpaceDetailPageProps = {
  tenantID: string;
  spaceID: string;
  client?: SpaceDetailClient;
};

type LoadState = "loading" | "ready" | "error" | "not-found";

export function SpaceDetailPage({ tenantID, spaceID, client = defaultSpaceDetailClient }: SpaceDetailPageProps) {
  const [space, setSpace] = useState<Space | null>(null);
  const [episodes, setEpisodes] = useState<DashboardEpisode[]>([]);
  const [state, setState] = useState<LoadState>("loading");
  const [error, setError] = useState<string | null>(null);
  const [reloadGeneration, setReloadGeneration] = useState(0);
  const [editOpen, setEditOpen] = useState(false);
  const [lifecycle, setLifecycle] = useState<"archive" | "restore" | null>(null);

  useEffect(() => {
    let active = true;
    setState("loading");
    setError(null);
    setSpace(null);
    setEpisodes([]);

    void Promise.all([client.getSpace({ tenantID, spaceID }), client.listEpisodes({ tenantID, spaceID, pageSize: 10 })])
      .then(([nextSpace, episodePage]) => {
        if (!active) return;
        setSpace(nextSpace);
        setEpisodes(recentEpisodes(episodePage.episodes));
        setState("ready");
      })
      .catch((cause: unknown) => {
        if (!active) return;
        if (isNotFoundError(cause)) {
          setState("not-found");
          return;
        }
        setError(spaceDetailError(cause));
        setState("error");
      });

    return () => {
      active = false;
    };
  }, [client, reloadGeneration, spaceID, tenantID]);

  function replaceSpace(nextSpace: Space) {
    setSpace(nextSpace);
    setEditOpen(false);
    setLifecycle(null);
  }

  if (state === "loading") return <SpaceDetailState kind="loading" />;
  if (state === "not-found") return <SpaceDetailState kind="not-found" />;
  if (state === "error") {
    return <SpaceDetailState kind="error" message={error ?? "The Space could not load."} onRetry={() => setReloadGeneration((current) => current + 1)} />;
  }
  if (!space) return <SpaceDetailState kind="not-found" />;

  const archived = space.archived;
  return (
    <div className="dashboard-page resource-page space-detail-page">
      <nav className="space-detail-breadcrumb" aria-label="Breadcrumb">
        <a href="/spaces">Spaces</a>
        <span aria-hidden="true">/</span>
        <span aria-current="page">{space.name}</span>
      </nav>

      <header className="space-detail-header">
        <div className="space-detail-title">
          <h1>{space.name}</h1>
          <div className="space-detail-identity">
            <code>/{space.slug}</code>
            <span className={`space-detail-status ${archived ? "is-archived" : "is-active"}`}>
              <span aria-hidden="true" />
              {archived ? "Archived" : "Active"}
            </span>
          </div>
          <p className="space-detail-status-copy">{archived ? "New joins are paused. History remains readable." : "Ready to join. Participants can enter this Space."}</p>
        </div>
        <div className="space-detail-actions" aria-label="Space actions">
          {!archived ? (
            <a className="dashboard-button primary" href={defaultSpaceHrefBuilder(space)}>
              Join Space
            </a>
          ) : null}
          <button className="dashboard-button secondary" type="button" onClick={() => setEditOpen(true)}>
            Edit
          </button>
          <button className="dashboard-button secondary" type="button" onClick={() => setLifecycle(archived ? "restore" : "archive")}>
            {archived ? "Restore" : "Archive"}
          </button>
        </div>
      </header>

      <div className="space-detail-layout">
        <div className="space-detail-main-column">
          <section className="space-detail-episodes space-detail-panel" aria-labelledby="space-episodes-heading">
            <div className="space-detail-section-heading">
              <h2 id="space-episodes-heading">Recent Episodes</h2>
              <a className="space-detail-history-link" href={`/episodes?space=${encodeURIComponent(space.id)}`}>
                View all history
              </a>
            </div>
            {episodes.length > 0 ? <RecentEpisodesTable episodes={episodes} /> : <p className="space-detail-empty">No Episodes have started in this Space yet.</p>}
          </section>

          <details className="space-detail-advanced space-detail-panel">
            <summary>Advanced configuration</summary>
            <div className="space-detail-advanced-body">
              <p>Raw policies and metadata are kept here for troubleshooting. Expand only when you need the underlying values.</p>
              <pre>
                {formatJSON({
                  metadata: space.metadata,
                  recurring_policy: space.recurring_policy,
                  admission_policy: space.admission_policy,
                  roles: space.roles,
                  default_episode_duration_seconds: space.default_episode_duration_seconds,
                  maximum_episode_duration_seconds: space.maximum_episode_duration_seconds,
                  linger_window_seconds: space.linger_window_seconds,
                })}
              </pre>
            </div>
          </details>
        </div>

        <SpaceDetailsCard space={space} />
      </div>

      <EditSpaceDialog open={editOpen} tenantID={tenantID} space={space} onClose={() => setEditOpen(false)} onSaved={replaceSpace} />
      <SpaceLifecycleDialog open={lifecycle !== null} tenantID={tenantID} space={space} action={lifecycle ?? "archive"} onClose={() => setLifecycle(null)} onChanged={replaceSpace} />
    </div>
  );
}

function RecentEpisodesTable({ episodes }: { episodes: DashboardEpisode[] }) {
  return (
    <div className="space-detail-table-wrap">
      <table className="space-detail-table">
        <caption className="sr-only">Recent Episodes</caption>
        <thead>
          <tr>
            <th scope="col">Episode ID</th>
            <th scope="col">Started</th>
            <th scope="col">Duration</th>
            <th scope="col">Participants</th>
            <th scope="col">Action</th>
          </tr>
        </thead>
        <tbody>
          {episodes.map((episode) => (
            <tr key={episode.id}>
              <th scope="row">
                <code>{episode.id}</code>
              </th>
              <td>
                <span>{formatDateTime(episode.started_at)}</span>
                <small className="space-detail-episode-state">{statusLabel(episode.status)}</small>
              </td>
              <td>{episodeDurationLabel(episode)}</td>
              <td className="space-detail-table-muted">—</td>
              <td>
                <a className="space-detail-row-link" href={episodeHistoryHref(episode)}>
                  Open <span aria-hidden="true">↗</span>
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SpaceDetailsCard({ space }: { space: Space }) {
  return (
    <aside className="space-detail-card" aria-labelledby="space-details-heading">
      <h2 id="space-details-heading">Space details</h2>
      <dl>
        <div className="space-detail-card-row">
          <dt>Admission</dt>
          <dd>
            <strong className="space-detail-admission-badge">{admissionLabel(space.admission_policy)}</strong>
            <span>{admissionDescription(space.admission_policy)}</span>
          </dd>
        </div>
        <div className="space-detail-card-row">
          <dt>Media plane</dt>
          <dd>
            <strong>{mediaPlaneLabel(space.media_plane)}</strong>
            <span>{space.media_plane || "Not configured"}</span>
          </dd>
        </div>
        <div className="space-detail-card-row">
          <dt>Default Episode duration</dt>
          <dd>
            <strong>{spaceDurationLabel(space.default_episode_duration_seconds)}</strong>
            <span>Used when an Episode does not provide a limit.</span>
          </dd>
        </div>
        <div className="space-detail-card-row">
          <dt>Maximum Episode duration</dt>
          <dd>
            <strong>{spaceDurationLabel(space.maximum_episode_duration_seconds)}</strong>
            <span>Hard limit for every Episode in this Space.</span>
          </dd>
        </div>
        <div className="space-detail-card-row">
          <dt>Linger window</dt>
          <dd>
            <strong>{spaceDurationLabel(space.linger_window_seconds, true)}</strong>
            <span>Time kept open after the last Participant leaves.</span>
          </dd>
        </div>
        <div className="space-detail-card-row">
          <dt>Created</dt>
          <dd>
            <strong>
              <time dateTime={space.created_at}>{formatDateTime(space.created_at)}</time>
            </strong>
            <span>{relativeDate(space.created_at)}</span>
          </dd>
        </div>
        <div className="space-detail-card-row">
          <dt>Owner</dt>
          <dd>
            <strong>{space.created_by_user_id ? "Account owner" : "Not recorded"}</strong>
            <span>{space.created_by_user_id ? <code>{space.created_by_user_id}</code> : "Owner identity unavailable"}</span>
          </dd>
        </div>
      </dl>
    </aside>
  );
}

function SpaceDetailState({ kind, message, onRetry }: { kind: "loading" | "error" | "not-found"; message?: string; onRetry?: () => void }) {
  if (kind === "loading") {
    return (
      <div className="dashboard-page resource-page space-detail-state" role="status" aria-busy="true" aria-live="polite">
        <h1>Loading Space…</h1>
        <p>Getting the Space configuration and latest Episode history.</p>
      </div>
    );
  }

  if (kind === "not-found") {
    return (
      <div className="dashboard-page resource-page space-detail-state" role="status">
        <h1>That Space is not available.</h1>
        <p>It may have been removed, or you may no longer have access to this Tenant.</p>
        <a className="dashboard-button secondary" href="/spaces">
          Back to Spaces
        </a>
      </div>
    );
  }

  return (
    <div className="dashboard-page resource-page space-detail-state" role="alert">
      <h1>We could not load this Space.</h1>
      <p>{message ?? "The Space could not load."}</p>
      <div className="space-detail-state-actions">
        <button className="dashboard-button primary" type="button" onClick={onRetry}>
          Try again
        </button>
        <a className="dashboard-button secondary" href="/spaces">
          Back to Spaces
        </a>
      </div>
    </div>
  );
}

function recentEpisodes(episodes: DashboardEpisode[]): DashboardEpisode[] {
  return [...episodes].sort((left, right) => Date.parse(right.started_at) - Date.parse(left.started_at)).slice(0, 10);
}

function isNotFoundError(cause: unknown): boolean {
  return cause instanceof DashboardAPIError && (cause.status === 404 || cause.code.includes("not_found"));
}

function spaceDetailError(cause: unknown): string {
  if (cause instanceof DashboardAPIError) return cause.message;
  return cause instanceof Error ? cause.message : "The Space could not load.";
}

function admissionLabel(value: unknown): string {
  const mode = value && typeof value === "object" && "mode" in value ? (value as { mode?: unknown }).mode : undefined;
  if (mode === "knock") return "Ask to join";
  if (mode === "members_only") return "Members only";
  if (mode === "open") return "Tenant access";
  return value === null || value === undefined ? "Default" : "Custom";
}

function admissionDescription(value: unknown): string {
  const mode = value && typeof value === "object" && "mode" in value ? (value as { mode?: unknown }).mode : undefined;
  if (mode === "knock") return "People request access before entering.";
  if (mode === "members_only") return "Only Space Members can enter.";
  return "Anyone with Tenant access can enter.";
}

function mediaPlaneLabel(value: string): string {
  if (value === "cf_rtk") return "Cloudflare RealtimeKit";
  return value || "Not configured";
}

function relativeDate(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "—";
  const days = Math.max(0, Math.floor((Date.now() - timestamp) / 86_400_000));
  if (days === 0) return "Updated today";
  if (days === 1) return "Updated yesterday";
  return `Updated ${days} days ago`;
}

function spaceDurationLabel(value: number | null | undefined, zeroAsNone = false): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "Not set";
  if (value === 0 && zeroAsNone) return "None";
  if (value < 60) return `${value} seconds`;
  if (value % 86_400 === 0) return `${value / 86_400} day${value === 86_400 ? "" : "s"}`;
  if (value % 3_600 === 0) return `${value / 3_600} hour${value === 3_600 ? "" : "s"}`;
  if (value % 60 === 0) return `${value / 60} minutes`;
  return `${value} seconds`;
}
