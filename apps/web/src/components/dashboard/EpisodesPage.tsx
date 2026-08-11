import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { EpisodeDiagnosticsAvailabilityClient } from "../../features/episode-debugger/EpisodeDiagnosticsDeveloperLink";
import { Icon } from "./DashboardShell";
import { EpisodeDetailPanel, type EpisodeDetailLoadState } from "./EpisodeDetail";
import { EndEpisodeDialog, StartEpisodeDialog } from "./EpisodeDialogs";
import { EpisodeEmptyState, EpisodeErrorState, EpisodeListLoading, EpisodePagination, NoSpacesState } from "./EpisodeStates";
import { durationLabel, formatDateTime, messageForError, readSearchParam, statusLabel, updateSearch } from "./episode-utils";
import { clearEpisodeEndRequest, createEpisode, endEpisode, getEpisode, listEpisodes, listSpaces, type DashboardEpisode, type DashboardEpisodePage, type DashboardPagination, type DashboardSpace, type DashboardSpacePage } from "../../lib/dashboard-api";
import { defaultSpaceHrefBuilder, type SpaceHrefBuilder } from "./space-links";

export type EpisodeStatus = DashboardEpisode["status"];

export type EpisodeClient = {
  listSpaces: (input: { tenantID: string; cursor?: string; pageSize?: number }) => Promise<DashboardSpacePage>;
  listEpisodes: (input: { tenantID: string; spaceID?: string; cursor?: string; pageSize?: number }) => Promise<DashboardEpisodePage>;
  getEpisode: (input: { tenantID: string; spaceID: string; episodeID: string }) => Promise<DashboardEpisode>;
  createEpisode: (input: { tenantID: string; spaceID: string; metadata?: unknown; started_at?: string }) => Promise<DashboardEpisode>;
  endEpisode: (input: { tenantID: string; spaceID: string; episodeID: string }) => Promise<unknown>;
};

const defaultEpisodeClient: EpisodeClient = { listSpaces, listEpisodes, getEpisode, createEpisode, endEpisode };

export function EpisodesPage({
  tenantID,
  api = defaultEpisodeClient,
  diagnosticsApi,
  spaceHrefBuilder = defaultSpaceHrefBuilder,
  navigateToSpace = (href) => globalThis.location.assign(href),
}: {
  tenantID: string;
  api?: EpisodeClient;
  diagnosticsApi?: EpisodeDiagnosticsAvailabilityClient;
  spaceHrefBuilder?: SpaceHrefBuilder;
  navigateToSpace?: (href: string) => void;
}) {
  const [spaces, setSpaces] = useState<DashboardSpace[]>([]);
  const [episodes, setEpisodes] = useState<DashboardEpisode[]>([]);
  const [pagination, setPagination] = useState<DashboardPagination | null>(null);
  const [cursorHistory, setCursorHistory] = useState<string[]>([]);
  const [spaceFilter, setSpaceFilter] = useState(() => readSearchParam("space") ?? "");
  const [statusFilter, setStatusFilter] = useState<EpisodeStatus | "all">("all");
  const [selectedEpisodeID, setSelectedEpisodeID] = useState(() => readSearchParam("episode"));
  const [detail, setDetail] = useState<DashboardEpisode | null>(null);
  const [listState, setListState] = useState<LoadState>("loading");
  const [listError, setListError] = useState<string | null>(null);
  const [detailState, setDetailState] = useState<EpisodeDetailLoadState>("idle");
  const [detailError, setDetailError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createSpaceID, setCreateSpaceID] = useState("");
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [endOpen, setEndOpen] = useState(false);
  const [endBusy, setEndBusy] = useState(false);
  const [endError, setEndError] = useState<string | null>(null);
  const [filterTenantID, setFilterTenantID] = useState(tenantID);
  const [refreshGeneration, setRefreshGeneration] = useState(0);

  const spacesByID = useMemo(() => new Map(spaces.map((space) => [space.id, space])), [spaces]);
  const activeSpaces = useMemo(() => spaces.filter((space) => !space.archived), [spaces]);
  const visibleEpisodes = useMemo(() => episodes.filter((episode) => statusFilter === "all" || episode.status === statusFilter), [episodes, statusFilter]);
  const selectedEpisode = detail ?? episodes.find((episode) => episode.id === selectedEpisodeID) ?? null;

  useEffect(() => {
    if (filterTenantID === tenantID) return;
    setFilterTenantID(tenantID);
    setSpaces([]);
    setEpisodes([]);
    setPagination(null);
    setCursorHistory([]);
    setSpaceFilter("");
    setStatusFilter("all");
    setSelectedEpisodeID(null);
    setDetail(null);
    setDetailState("idle");
    setDetailError(null);
    setCreateOpen(false);
    setCreateSpaceID("");
    setCreateBusy(false);
    setCreateError(null);
    setEndOpen(false);
    setEndBusy(false);
    setEndError(null);
    setListState("loading");
    setListError(null);
    updateSearch({ space: null, episode: null });
  }, [filterTenantID, tenantID]);

  useEffect(() => {
    if (filterTenantID !== tenantID) return;
    let active = true;
    setListState("loading");
    setListError(null);
    void Promise.all([api.listSpaces({ tenantID, pageSize: 100 }), api.listEpisodes({ tenantID, spaceID: spaceFilter || undefined, cursor: cursorHistory.at(-1), pageSize: 25 })])
      .then(([spacePage, episodePage]) => {
        if (!active) return;
        setSpaces(spacePage.spaces);
        setEpisodes(episodePage.episodes);
        setPagination(episodePage.pagination);
        setListState("ready");
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setListError(messageForError(cause, "Episodes could not load"));
        setListState("error");
      });
    return () => {
      active = false;
    };
  }, [api, cursorHistory, filterTenantID, refreshGeneration, spaceFilter, tenantID]);

  useEffect(() => {
    const refresh = () => setRefreshGeneration((value) => value + 1);
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    const interval = globalThis.setInterval(refreshWhenVisible, 10_000);
    globalThis.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      globalThis.clearInterval(interval);
      globalThis.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, []);

  useEffect(() => {
    if (filterTenantID !== tenantID) return;
    if (!selectedEpisodeID) {
      setDetail(null);
      setDetailState("idle");
      setDetailError(null);
      return;
    }
    const summary = episodes.find((episode) => episode.id === selectedEpisodeID);
    if (!summary) return;
    let active = true;
    setDetailState("loading");
    setDetailError(null);
    void api
      .getEpisode({ tenantID, spaceID: summary.space_id, episodeID: summary.id })
      .then((episode) => {
        if (!active) return;
        setDetail(episode);
        setDetailState("ready");
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setDetailError(messageForError(cause, "Episode details could not load"));
        setDetailState("error");
      });
    return () => {
      active = false;
    };
  }, [api, episodes, filterTenantID, selectedEpisodeID, tenantID]);

  useEffect(() => {
    const onPopState = () => {
      setSpaceFilter(readSearchParam("space") ?? "");
      setSelectedEpisodeID(readSearchParam("episode"));
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    if (listState !== "ready" || !selectedEpisodeID || episodes.some((episode) => episode.id === selectedEpisodeID)) return;
    setSelectedEpisodeID(null);
    updateSearch({ episode: null });
  }, [episodes, listState, selectedEpisodeID]);

  function selectSpace(nextSpaceID: string) {
    setSpaceFilter(nextSpaceID);
    setCursorHistory([]);
    updateSearch({ space: nextSpaceID || null, episode: null });
    setSelectedEpisodeID(null);
    setDetail(null);
  }

  function selectEpisode(episode: DashboardEpisode) {
    setSelectedEpisodeID(episode.id);
    updateSearch({ space: episode.space_id, episode: episode.id });
  }

  function openCreate() {
    setCreateError(null);
    const selectedSpace = activeSpaces.some((space) => space.id === spaceFilter) ? spaceFilter : (activeSpaces[0]?.id ?? "");
    setCreateSpaceID(selectedSpace);
    setCreateOpen(true);
  }

  async function submitCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!createSpaceID) return;
    setCreateBusy(true);
    setCreateError(null);
    try {
      const created = await api.createEpisode({ tenantID, spaceID: createSpaceID });
      setCreateOpen(false);
      setEpisodes((current) => [created, ...current.filter((episode) => episode.id !== created.id)]);
      setSelectedEpisodeID(created.id);
      updateSearch({ space: created.space_id, episode: created.id });
      setSpaceFilter(created.space_id);
      setCursorHistory([]);
      const space = activeSpaces.find((item) => item.id === created.space_id);
      if (space) navigateToSpace(spaceHrefBuilder(space));
    } catch (cause) {
      setCreateError(messageForError(cause, "Episode could not start"));
    } finally {
      setCreateBusy(false);
    }
  }

  async function confirmEnd() {
    const episode = selectedEpisode;
    if (!episode || episode.status === "ended") return;
    setEndBusy(true);
    setEndError(null);
    try {
      await api.endEpisode({ tenantID, spaceID: episode.space_id, episodeID: episode.id });
      const refreshed = await api.getEpisode({ tenantID, spaceID: episode.space_id, episodeID: episode.id });
      if (refreshed.status === "ended") clearEpisodeEndRequest({ tenantID, spaceID: episode.space_id, episodeID: episode.id });
      setDetail(refreshed);
      setEpisodes((current) => current.map((item) => (item.id === refreshed.id ? refreshed : item)));
      setEndOpen(false);
    } catch (cause) {
      setEndError(messageForError(cause, "Episode could not end"));
    } finally {
      setEndBusy(false);
    }
  }

  return (
    <div className="dashboard-page resource-page episodes-page">
      <header className="dashboard-page-header resource-heading episodes-page-header">
        <div>
          <h1>Episodes</h1>
          <p>Tenant-wide history of the bounded runs that move work forward.</p>
          <p className="episodes-prerequisite-note">Starting an Episode is optional. Joining a Space can begin one automatically.</p>
        </div>
        <button className="dashboard-button primary episodes-start-button" type="button" onClick={openCreate} disabled={activeSpaces.length === 0 || listState === "loading"}>
          <Icon name="plus" />
          Start and join
        </button>
      </header>

      <div className={`episodes-layout${selectedEpisodeID ? " has-detail" : ""}`}>
        <div className="episodes-main">
          <div className="resource-toolbar episodes-toolbar" aria-label="Episode filters">
            <label className="episodes-filter">
              <span>Space</span>
              <select value={spaceFilter} onChange={(event) => selectSpace(event.target.value)} disabled={listState === "loading"}>
                <option value="">All Spaces</option>
                {spaces.map((space) => (
                  <option value={space.id} key={space.id}>
                    {space.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="episodes-filter">
              <span>Status</span>
              <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as EpisodeStatus | "all")}>
                <option value="all">All states</option>
                <option value="active">Live now</option>
                <option value="ending">Ending</option>
                <option value="ended">Ended</option>
              </select>
            </label>
            <span className="episodes-filter-summary">{spaceFilter ? "Space history · pagination" : "Tenant-wide history"}</span>
          </div>

          {listState === "loading" ? <EpisodeListLoading /> : null}
          {listState === "error" ? <EpisodeErrorState message={listError ?? "Episodes could not load"} onRetry={() => setCursorHistory((current) => [...current])} /> : null}
          {listState === "ready" && spaces.length === 0 ? <NoSpacesState /> : null}
          {listState === "ready" && spaces.length > 0 && visibleEpisodes.length === 0 ? <EpisodeEmptyState filtered={statusFilter !== "all" || Boolean(spaceFilter) || activeSpaces.length === 0} onStart={openCreate} /> : null}
          {listState === "ready" && visibleEpisodes.length > 0 ? (
            <section className="episode-list-panel" aria-label="Episodes">
              <div className="episode-list-heading">
                <span>{spaceFilter ? "Episodes in this Space" : "All Spaces"}</span>
                <span>{visibleEpisodes.length} shown</span>
              </div>
              <div className="episode-table-scroll">
                <table className="episode-table">
                  <thead>
                    <tr>
                      <th scope="col">Episode</th>
                      <th scope="col">Space</th>
                      <th scope="col">Status</th>
                      <th scope="col">Started</th>
                      <th scope="col">Duration</th>
                      <th scope="col">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleEpisodes.map((episode) => {
                      const space = spacesByID.get(episode.space_id);
                      return (
                        <tr className={`episode-status-${episode.status} ${episode.id === selectedEpisodeID ? "is-selected" : ""}`} key={episode.id}>
                          <th scope="row">
                            <button className="episode-name-button" type="button" onClick={() => selectEpisode(episode)} aria-label={`View details for ${space?.name ?? "Space"} Episode ${episode.id}`}>
                              <span className="episode-status-mark" aria-hidden="true" />
                              <code>{episode.id}</code>
                            </button>
                          </th>
                          <td>
                            <span className="episode-space-cell">
                              <strong>{space?.name ?? "Space"}</strong>
                              <code>{space?.slug ?? "Space slug unavailable"}</code>
                            </span>
                          </td>
                          <td>
                            <span className={`episode-status-chip episode-status-chip-${episode.status}`}>
                              <span aria-hidden="true" />
                              {statusLabel(episode.status)}
                            </span>
                          </td>
                          <td>
                            <time dateTime={episode.started_at}>{formatDateTime(episode.started_at)}</time>
                          </td>
                          <td>{episode.status === "active" ? `Ends ${formatDateTime(episode.deadline_at)}` : durationLabel(episode)}</td>
                          <td>
                            <div className="episode-row-actions">
                              <button className="dashboard-button secondary" type="button" onClick={() => selectEpisode(episode)}>
                                View details
                              </button>
                              {space && !space.archived ? (
                                <a className="dashboard-button primary" href={spaceHrefBuilder(space)}>
                                  Join Space
                                </a>
                              ) : null}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}

          {listState === "ready" && spaces.length > 0 ? (
            <EpisodePagination pagination={pagination} cursorHistory={cursorHistory} onPrevious={() => setCursorHistory((current) => current.slice(0, -1))} onNext={() => pagination?.next_cursor && setCursorHistory((current) => [...current, pagination.next_cursor as string])} />
          ) : null}
        </div>

        {selectedEpisodeID ? (
          <EpisodeDetailPanel
            episode={selectedEpisode}
            spaceName={selectedEpisode ? spacesByID.get(selectedEpisode.space_id)?.name : undefined}
            spaceSlug={selectedEpisode ? spacesByID.get(selectedEpisode.space_id)?.slug : undefined}
            spaceArchived={selectedEpisode ? spacesByID.get(selectedEpisode.space_id)?.archived : undefined}
            spaceHrefBuilder={spaceHrefBuilder}
            state={detailState}
            error={detailError}
            onRetry={() => setEpisodes((current) => [...current])}
            onClose={() => {
              setSelectedEpisodeID(null);
              setDetail(null);
              updateSearch({ episode: null });
            }}
            onEnd={() => {
              setEndError(null);
              setEndOpen(true);
            }}
            diagnosticsApi={diagnosticsApi}
          />
        ) : null}
      </div>

      <StartEpisodeDialog open={createOpen} spaces={activeSpaces} selectedSpaceID={createSpaceID} busy={createBusy} error={createError} onClose={() => setCreateOpen(false)} onSpaceChange={setCreateSpaceID} onSubmit={submitCreate} />
      <EndEpisodeDialog open={endOpen} episode={selectedEpisode} busy={endBusy} error={endError} onClose={() => setEndOpen(false)} onConfirm={() => void confirmEnd()} />
    </div>
  );
}

type LoadState = "idle" | "loading" | "ready" | "error";
