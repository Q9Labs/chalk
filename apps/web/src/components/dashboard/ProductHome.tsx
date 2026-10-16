import { Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { DashboardAPIError, listEpisodes, listSpaces, type DashboardEpisode, type DashboardSpace } from "../../lib/dashboard-api";
import { useDashboardAccount } from "./DashboardAccount";
import { Icon, openNewSpaceDialog } from "./DashboardShell";
import { dashboardSpaceHref, defaultSpaceHrefBuilder, episodeHistoryHref, type SpaceHrefBuilder } from "./space-links";

type HomeState = { spaces: DashboardSpace[]; allSpaces: DashboardSpace[]; episodes: DashboardEpisode[] };

export function ProductHome({ spaceHrefBuilder = defaultSpaceHrefBuilder }: { spaceHrefBuilder?: SpaceHrefBuilder } = {}) {
  const { current } = useDashboardAccount();
  const tenantID = current.tenant.id;
  const [state, setState] = useState<HomeState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setState(null);
    setError(null);
    void Promise.all([listSpaces({ tenantID, pageSize: 6, archived: false }), listSpaces({ tenantID, pageSize: 100 }), listEpisodes({ tenantID })])
      .then(([spaces, allSpaces, episodes]) => {
        if (active) setState({ spaces: spaces.spaces, allSpaces: allSpaces.spaces, episodes: episodes.episodes });
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setError(cause instanceof DashboardAPIError ? cause.message : "Your recent work could not be loaded");
      });
    return () => {
      active = false;
    };
  }, [tenantID]);

  const episodesBySpace = useMemo(() => {
    const grouped = new Map<string, DashboardEpisode[]>();
    for (const episode of state?.episodes ?? []) grouped.set(episode.space_id, [...(grouped.get(episode.space_id) ?? []), episode]);
    return grouped;
  }, [state]);
  const spacesByID = useMemo(() => new Map((state?.allSpaces ?? []).map((space) => [space.id, space])), [state]);
  const recentEpisodes = state?.episodes.slice(0, 5) ?? [];

  return (
    <div className="dashboard-page home-page">
      <header className="dashboard-page-header home-heading">
        <h1>Overview</h1>
      </header>

      {error ? (
        <section className="dashboard-state dashboard-state-error" aria-live="polite">
          <h2>Your Spaces could not load.</h2>
          <p>{error}</p>
          <button className="dashboard-button secondary" type="button" onClick={() => window.location.reload()}>
            Try again
          </button>
        </section>
      ) : null}

      <section className="home-section">
        <div className="section-title-row">
          <h2>Your Spaces</h2>
          <Link to="/spaces">
            See all <Icon name="arrow" />
          </Link>
        </div>
        {!state && !error ? <HomeLoading label="Loading Spaces" /> : null}
        {state?.spaces.length === 0 ? (
          <div className="dashboard-state dashboard-state-empty">
            <h3>No Spaces yet.</h3>
            <p>A Space gives you one link that people use to join.</p>
            <button className="dashboard-button primary" type="button" onClick={openNewSpaceDialog}>
              New Space
            </button>
          </div>
        ) : null}
        {state?.spaces.length ? (
          <div className="space-card-grid">
            {state.spaces.slice(0, 4).map((space) => {
              const episodes = episodesBySpace.get(space.id) ?? [];
              const live = episodes.some((episode) => episode.status !== "ended");
              const description = spaceDescription(space);
              return (
                <article className="space-card" key={space.id}>
                  <h3>
                    <Link to={dashboardSpaceHref(space)}>{space.name}</Link>
                  </h3>
                  {description ? <p>{description}</p> : null}
                  <footer>
                    <span>{live ? <span className="status-live">Live</span> : episodes.length === 1 ? "1 Episode" : `${episodes.length} Episodes`}</span>
                    <a className="space-card-join" href={spaceHrefBuilder(space)}>
                      Join <Icon name="arrow" />
                    </a>
                  </footer>
                </article>
              );
            })}
          </div>
        ) : null}
      </section>

      <section className="home-section recent-panel">
        <div className="section-title-row">
          <h2>Recent Episodes</h2>
          <Link to="/episodes">
            See all <Icon name="arrow" />
          </Link>
        </div>
        {!state && !error ? <HomeLoading label="Loading Episodes" /> : null}
        {state && recentEpisodes.length === 0 ? <p className="dashboard-muted-copy">Episodes appear here after someone joins a Space.</p> : null}
        {recentEpisodes.length ? (
          <div className="timeline-list">
            {recentEpisodes.map((episode) => (
              <a className="timeline-list-card" key={episode.id} href={episodeHistoryHref(episode)}>
                <h3>{spacesByID.get(episode.space_id)?.name ?? "Space"}</h3>
                {episode.status === "ended" ? <span /> : <span className="status-live">Live</span>}
                <time dateTime={episode.started_at}>{relativeTime(episode.started_at)}</time>
              </a>
            ))}
          </div>
        ) : null}
      </section>
    </div>
  );
}

function HomeLoading({ label }: { label: string }) {
  return (
    <div className="dashboard-loading-inline" aria-live="polite">
      <span /> {label}…
    </div>
  );
}

function relativeTime(value: string): string {
  const difference = Date.now() - Date.parse(value);
  if (!Number.isFinite(difference) || difference < 0) return "Just now";
  const minutes = Math.max(1, Math.floor(difference / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(value));
}

function spaceDescription(space: DashboardSpace): string | undefined {
  if (space.metadata && typeof space.metadata === "object" && !Array.isArray(space.metadata)) {
    const description = (space.metadata as Record<string, unknown>).description;
    if (typeof description === "string" && description.trim()) return description;
  }
  return undefined;
}
