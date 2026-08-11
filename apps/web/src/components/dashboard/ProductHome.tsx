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
  const liveEpisodes = state?.episodes.filter((episode) => episode.status !== "ended").slice(0, 5) ?? [];
  const activity = useMemo(() => activityPoints(state?.episodes ?? []), [state]);

  return (
    <div className="dashboard-page home-page">
      <header className="dashboard-page-header home-heading">
        <div>
          <h1>Overview</h1>
          <p>
            Good {dayPeriod()}, {firstName(account.name)}. Continue where you left off across your Spaces and Episodes.
          </p>
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
        <SummaryCard icon="spaces" label="Spaces in view" value={state ? String(state.spaces.length) : "—"} detail="Durable places for recurring work" />
        <SummaryCard icon="episodes" label="Live Episodes" value={state ? String(liveEpisodeCount) : "—"} detail={liveEpisodeCount === 1 ? "1 Episode is active" : `${liveEpisodeCount} Episodes are active`} tone="live" />
        <SummaryCard icon="activity" label="Recent Episodes" value={state ? String(state.episodes.length) : "—"} detail="Loaded from the selected Tenant" />
      </section>

      <div className="home-overview-grid">
        <section className="home-panel home-activity-panel" aria-labelledby="activity-heading">
          <div className="section-title-row">
            <div>
              <h2 id="activity-heading">Activity</h2>
              <p>Episodes started over the last seven days.</p>
            </div>
            <Link to="/episodes">
              View history <Icon name="arrow" />
            </Link>
          </div>
          {!state && !error ? <HomeLoading label="Loading activity" /> : null}
          {state ? <ActivityChart points={activity} /> : null}
        </section>

        <section className="home-panel home-live-panel" aria-labelledby="live-heading">
          <div className="section-title-row">
            <h2 id="live-heading">Live now</h2>
            <Link to="/episodes">View all</Link>
          </div>
          {!state && !error ? <HomeLoading label="Loading live Episodes" /> : null}
          {state && liveEpisodes.length === 0 ? <p className="dashboard-muted-copy">No live Episodes right now.</p> : null}
          {liveEpisodes.length ? (
            <div className="home-live-list">
              {liveEpisodes.map((episode) => {
                const space = spacesByID.get(episode.space_id);
                return (
                  <a className="home-live-row" href={episodeHistoryHref(episode)} key={episode.id}>
                    <span className="home-live-icon">
                      <Icon name="episodes" />
                    </span>
                    <span className="home-live-copy">
                      <strong>{space?.name ?? "Space Episode"}</strong>
                      <small>{space?.slug ?? "Space slug unavailable"}</small>
                    </span>
                    <span className="status-live">{episode.status === "ending" ? "Ending" : "Live"}</span>
                    <Icon name="arrow" />
                  </a>
                );
              })}
            </div>
          ) : null}
        </section>
      </div>

      <div className="home-lower-grid">
        <section className="home-panel recent-panel" aria-labelledby="recent-heading">
          <div className="section-title-row">
            <h2 id="recent-heading">Recent Episodes</h2>
            <Link to="/episodes">View all</Link>
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

        <section className="home-panel spaces-panel" aria-labelledby="spaces-heading">
          <div className="section-title-row">
            <h2 id="spaces-heading">Spaces</h2>
            <Link to="/spaces">View all</Link>
          </div>
          {!state && !error ? <HomeLoading label="Loading Spaces" /> : null}
          {state?.spaces.length === 0 ? <p className="dashboard-muted-copy">Create your first Space to give recurring work a home.</p> : null}
          {state?.spaces.length ? (
            <div className="home-spaces-list">
              {state.spaces.slice(0, 5).map((space) => {
                const episodes = episodesBySpace.get(space.id) ?? [];
                const live = episodes.some((episode) => episode.status !== "ended");
                return (
                  <article className="home-space-row" key={space.id}>
                    <span className="space-glyph" aria-hidden="true">
                      {space.name.slice(0, 1).toUpperCase()}
                    </span>
                    <span className="home-space-copy">
                      <Link to={dashboardSpaceHref(space)}>
                        <strong>{space.name}</strong>
                      </Link>
                      <small>{space.slug}</small>
                    </span>
                    <span className={live ? "status-live" : "status-idle"}>{live ? "Live" : "Ready"}</span>
                    <Link className="home-space-details" to={dashboardSpaceHref(space)}>
                      View details
                    </Link>
                    <a className="home-space-join" href={spaceHrefBuilder(space)} aria-label={`Join ${space.name}`}>
                      Join Space <Icon name="arrow" />
                    </a>
                  </article>
                );
              })}
            </div>
          ) : null}
        </section>
      </div>

      <aside className="home-help-panel" aria-labelledby="home-help-title">
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
      </aside>
    </div>
  );
}

function SummaryCard({ icon, label, value, detail, tone }: { icon: string; label: string; value: string; detail: string; tone?: "live" }) {
  return (
    <article className={`home-summary-card${tone ? ` is-${tone}` : ""}`}>
      <span className="home-summary-icon">
        <Icon name={icon} />
      </span>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  );
}

function ActivityChart({ points }: { points: readonly ActivityPoint[] }) {
  const max = Math.max(1, ...points.map((point) => point.count));
  return (
    <div className="home-activity-chart" role="img" aria-label={`Episode activity chart with ${points.reduce((total, point) => total + point.count, 0)} Episodes over seven days`}>
      {points.map((point) => (
        <div className="home-activity-point" key={point.key}>
          <span style={{ blockSize: `${Math.max(8, (point.count / max) * 100)}%` }} title={`${point.count} Episodes`} />
          <small>{point.label}</small>
        </div>
      ))}
    </div>
  );
}

type ActivityPoint = { key: string; label: string; count: number };

function activityPoints(episodes: readonly DashboardEpisode[]): ActivityPoint[] {
  const today = new Date();
  const points: ActivityPoint[] = [];
  for (let offset = 6; offset >= 0; offset -= 1) {
    const date = new Date(today);
    date.setHours(0, 0, 0, 0);
    date.setDate(today.getDate() - offset);
    const key = date.toISOString().slice(0, 10);
    points.push({ key, label: new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(date), count: episodes.filter((episode) => sameCalendarDay(episode.started_at, date)).length });
  }
  return points;
}

function sameCalendarDay(value: string, date: Date): boolean {
  const episodeDate = new Date(value);
  return episodeDate.getFullYear() === date.getFullYear() && episodeDate.getMonth() === date.getMonth() && episodeDate.getDate() === date.getDate();
}

function HomeLoading({ label }: { label: string }) {
  return (
    <div className="dashboard-loading-inline" aria-live="polite">
      <span /> {label}…
    </div>
  );
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
