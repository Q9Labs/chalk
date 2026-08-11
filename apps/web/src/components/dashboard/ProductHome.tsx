import { Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { DashboardAPIError, listEpisodes, listSpaces, type DashboardEpisode, type DashboardSpace } from "../../lib/dashboard-api";
import { useDashboardAccount } from "./DashboardAccount";
import { Icon } from "./DashboardShell";
import { dashboardSpaceHref, defaultSpaceHrefBuilder, episodeHistoryHref, type SpaceHrefBuilder } from "./space-links";

type HomeState = { spaces: DashboardSpace[]; episodes: DashboardEpisode[] };

export function ProductHome({ spaceHrefBuilder = defaultSpaceHrefBuilder }: { spaceHrefBuilder?: SpaceHrefBuilder } = {}) {
  const { account, current } = useDashboardAccount();
  const tenantID = current.tenant.id;
  const [state, setState] = useState<HomeState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setState(null);
    setError(null);
    void Promise.all([listSpaces({ tenantID, pageSize: 6, archived: false }), listEpisodes({ tenantID })])
      .then(([spaces, episodes]) => {
        if (active) setState({ spaces: spaces.spaces, episodes: episodes.episodes });
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
  const spacesByID = useMemo(() => new Map((state?.spaces ?? []).map((space) => [space.id, space])), [state]);
  const recentEpisodes = state?.episodes.slice(0, 5) ?? [];
  const liveEpisodeCount = state?.episodes.filter((episode) => episode.status !== "ended").length ?? 0;

  return (
    <div className="dashboard-page home-page">
      <header className="dashboard-page-header home-heading">
        <div>
          <p className="eyebrow">{formatToday()}</p>
          <h1>
            Good {dayPeriod()}, {firstName(account.name)}.
          </h1>
          <p>Continue where you left off across your Spaces and Episodes.</p>
        </div>
        <Link className="dashboard-button primary home-quick-link" to="/spaces">
          Open Spaces <Icon name="arrow" />
        </Link>
      </header>

      {error ? (
        <section className="dashboard-state dashboard-state-error" aria-live="polite">
          <h2>Your work is still here.</h2>
          <p>{error}</p>
          <button className="dashboard-button secondary" type="button" onClick={() => window.location.reload()}>
            Try again
          </button>
        </section>
      ) : null}

      <section className="home-summary" aria-label="Tenant overview">
        <SummaryCard label="Spaces in view" value={state ? String(state.spaces.length) : "—"} detail="Durable places for recurring work" />
        <SummaryCard label="Live now" value={state ? String(liveEpisodeCount) : "—"} detail={liveEpisodeCount === 1 ? "1 Episode is active" : `${liveEpisodeCount} Episodes are active`} tone="live" />
        <SummaryCard label="Recent Episodes" value={state ? String(state.episodes.length) : "—"} detail="Loaded from the selected Tenant" />
      </section>

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
            <h3>Create the first place your work can return to.</h3>
            <p>A Space stays available between live Episodes and keeps its configuration and history together.</p>
            <Link className="dashboard-button primary" to="/spaces">
              Create a Space
            </Link>
          </div>
        ) : null}
        {state?.spaces.length ? (
          <div className="space-card-grid">
            {state.spaces.slice(0, 4).map((space, index) => {
              const episodes = episodesBySpace.get(space.id) ?? [];
              const live = episodes.some((episode) => episode.status !== "ended");
              return (
                <article className={`space-card accent-${accent(index)}`} key={space.id}>
                  <div className="space-card-top">
                    <span className="space-glyph" aria-hidden="true">
                      {space.name.slice(0, 1).toUpperCase()}
                    </span>
                    <span className={live ? "status-live" : "status-idle"}>{live ? "Episode live" : "Ready"}</span>
                  </div>
                  <h3>
                    <Link to={dashboardSpaceHref(space)}>{space.name}</Link>
                  </h3>
                  <p>{spaceDescription(space)}</p>
                  <footer>
                    <span>{episodes.length === 1 ? "1 Episode" : `${episodes.length} Episodes`}</span>
                    <span className="space-card-actions">
                      <Link to={dashboardSpaceHref(space)}>View details</Link>
                      <a className="space-card-join" href={spaceHrefBuilder(space)}>
                        Join Space <Icon name="arrow" />
                      </a>
                    </span>
                  </footer>
                </article>
              );
            })}
          </div>
        ) : null}
      </section>

      <div className="home-lower-grid">
        <section className="home-section recent-panel">
          <div className="section-title-row">
            <h2>Recent Episodes</h2>
            <Link to="/episodes">History</Link>
          </div>
          {!state && !error ? <HomeLoading label="Loading Episodes" /> : null}
          {state && recentEpisodes.length === 0 ? <p className="dashboard-muted-copy">Your first live Episode will appear here.</p> : null}
          {recentEpisodes.length ? (
            <div className="timeline-list">
              {recentEpisodes.map((episode, index) => (
                <a className="timeline-list-card" key={episode.id} href={episodeHistoryHref(episode)}>
                  <span className={`timeline-dot dot-${(index % 3) + 1}`} />
                  <div>
                    <h3>{spacesByID.get(episode.space_id)?.name ?? "Space Episode"}</h3>
                    <small>{spacesByID.get(episode.space_id)?.slug ?? "Space slug unavailable"}</small>
                    <p>{episode.status === "ended" ? "Ended Episode" : "Live Episode"}</p>
                  </div>
                  <time dateTime={episode.started_at}>{relativeTime(episode.started_at)}</time>
                  <span className="timeline-list-card-action">
                    Open history <Icon name="arrow" />
                  </span>
                </a>
              ))}
            </div>
          ) : null}
        </section>
        <aside className="home-section home-help-panel" aria-labelledby="home-help-title">
          <div className="section-title-row">
            <h2 id="home-help-title">Quick actions</h2>
          </div>
          <div className="home-action-list">
            <Link to="/spaces">
              <span className="home-action-icon">
                <Icon name="plus" />
              </span>
              <span>
                <strong>Create or manage a Space</strong>
                <small>Change access, timing, and join settings.</small>
              </span>
              <Icon name="arrow" />
            </Link>
            <Link to="/episodes">
              <span className="home-action-icon">
                <Icon name="episodes" />
              </span>
              <span>
                <strong>Review Episode history</strong>
                <small>Open immutable details and diagnostics.</small>
              </span>
              <Icon name="arrow" />
            </Link>
            <Link to="/developer">
              <span className="home-action-icon">
                <Icon name="developer" />
              </span>
              <span>
                <strong>Set up the SDK</strong>
                <small>Manage API keys and developer tools.</small>
              </span>
              <Icon name="arrow" />
            </Link>
          </div>
          <div className="dashboard-state dashboard-state-quiet home-help-note">
            <div>
              <h3>Joining is separate from managing.</h3>
              <p>Use Join Space to enter live work. Use View details to manage the durable Space.</p>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

function SummaryCard({ label, value, detail, tone }: { label: string; value: string; detail: string; tone?: "live" }) {
  return (
    <article className={`home-summary-card${tone ? ` is-${tone}` : ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  );
}

function HomeLoading({ label }: { label: string }) {
  return (
    <div className="dashboard-loading-inline" aria-live="polite">
      <span /> {label}…
    </div>
  );
}

function formatToday(): string {
  return new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" }).format(new Date());
}

function dayPeriod(): string {
  const hour = new Date().getHours();
  if (hour < 12) return "morning";
  if (hour < 18) return "afternoon";
  return "evening";
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || "there";
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

function spaceDescription(space: DashboardSpace): string {
  if (space.metadata && typeof space.metadata === "object" && !Array.isArray(space.metadata)) {
    const description = (space.metadata as Record<string, unknown>).description;
    if (typeof description === "string" && description.trim()) return description;
  }
  return `A durable home for recurring Episodes at /${space.slug}.`;
}

function accent(index: number): "green" | "blue" | "yellow" | "pink" {
  return (["green", "blue", "yellow", "pink"] as const)[index % 4]!;
}
