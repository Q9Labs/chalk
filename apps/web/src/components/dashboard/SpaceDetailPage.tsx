import { useEffect, useState } from "react";
import { DashboardAPIError, getSpace, listEpisodes, type DashboardEpisode, type DashboardEpisodePage, type Space } from "../../lib/dashboard-api";
import { EditSpaceDialog } from "./EditSpaceDialog";
import { SpaceLifecycleDialog } from "./SpaceLifecycleDialog";
import { episodeHistoryHref, defaultSpaceHrefBuilder } from "./space-links";
import { formatDateTime, formatJSON, statusLabel } from "./episode-utils";

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
          <p className="eyebrow">Space administration</p>
          <h1>{space.name}</h1>
          <div className="space-detail-identity">
            <code>{space.slug}</code>
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

      <section className="space-detail-overview" aria-labelledby="space-overview-heading">
        <div className="space-detail-section-heading">
          <div>
            <p className="eyebrow">Configuration</p>
            <h2 id="space-overview-heading">Space overview</h2>
          </div>
          <span className="space-detail-slug-label">/{space.slug}</span>
        </div>
        <dl className="space-detail-definition-grid">
          <DefinitionCard label="Admission mode" value={admissionLabel(space.admission_policy)} />
          <DefinitionCard label="Media plane" value={mediaPlaneLabel(space.media_plane)} detail={space.media_plane} />
          <DefinitionCard label="Default Episode duration" value={durationLabel(space.default_episode_duration_seconds)} />
          <DefinitionCard label="Maximum Episode duration" value={durationLabel(space.maximum_episode_duration_seconds)} />
          <DefinitionCard label="Linger window" value={durationLabel(space.linger_window_seconds, true)} />
        </dl>
      </section>

      <section className="space-detail-episodes" aria-labelledby="space-episodes-heading">
        <div className="space-detail-section-heading">
          <div>
            <p className="eyebrow">History</p>
            <h2 id="space-episodes-heading">Recent Episodes</h2>
          </div>
          <a className="space-detail-history-link" href={`/episodes?space=${encodeURIComponent(space.id)}`}>
            View all history
          </a>
        </div>
        {episodes.length > 0 ? <RecentEpisodesTable episodes={episodes} /> : <p className="space-detail-empty">No Episodes have started in this Space yet.</p>}
      </section>

      <details className="space-detail-advanced">
        <summary>Advanced configuration</summary>
        <div className="space-detail-advanced-body">
          <p>Raw policies and metadata are kept here for troubleshooting. Expand only when you need the underlying values.</p>
          <pre>{formatJSON({ metadata: space.metadata, recurring_policy: space.recurring_policy, admission_policy: space.admission_policy, roles: space.roles })}</pre>
        </div>
      </details>

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
            <th scope="col">Started</th>
            <th scope="col">Status</th>
            <th scope="col">Ended</th>
            <th scope="col">
              <span className="sr-only">Open</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {episodes.map((episode) => (
            <tr key={episode.id}>
              <th scope="row">{formatDateTime(episode.started_at)}</th>
              <td>
                <span className={`space-detail-episode-status status-${episode.status}`}>{statusLabel(episode.status)}</span>
              </td>
              <td>{formatDateTime(episode.ended_at)}</td>
              <td>
                <a className="space-detail-row-link" href={episodeHistoryHref(episode)}>
                  Open Episode
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DefinitionCard({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="space-detail-definition-card">
      <dt>{label}</dt>
      <dd>{value}</dd>
      {detail ? (
        <small>
          <code>{detail}</code>
        </small>
      ) : null}
    </div>
  );
}

function SpaceDetailState({ kind, message, onRetry }: { kind: "loading" | "error" | "not-found"; message?: string; onRetry?: () => void }) {
  if (kind === "loading") {
    return (
      <div className="dashboard-page resource-page space-detail-state" role="status" aria-busy="true" aria-live="polite">
        <p className="eyebrow">Space administration</p>
        <h1>Loading Space…</h1>
        <p>Getting the Space configuration and latest Episode history.</p>
      </div>
    );
  }

  if (kind === "not-found") {
    return (
      <div className="dashboard-page resource-page space-detail-state" role="status">
        <p className="eyebrow">Space not found</p>
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
      <p className="eyebrow">Space unavailable</p>
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

function mediaPlaneLabel(value: string): string {
  if (value === "cf_rtk") return "Cloudflare RealtimeKit";
  return value || "Not configured";
}

function durationLabel(value: number | null | undefined, zeroAsNone = false): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "Not set";
  if (value === 0 && zeroAsNone) return "None";
  if (value < 60) return `${value} seconds`;
  if (value % 86_400 === 0) return `${value / 86_400} day${value === 86_400 ? "" : "s"}`;
  if (value % 3_600 === 0) return `${value / 3_600} hour${value === 3_600 ? "" : "s"}`;
  if (value % 60 === 0) return `${value / 60} minutes`;
  return `${value} seconds`;
}
