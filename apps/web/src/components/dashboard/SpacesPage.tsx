import { useEffect, useMemo, useState } from "react";
import { DashboardAPIError, listSpaces, type Space } from "../../lib/dashboard-api";
import { Icon, ResourcePageHeader } from "./DashboardShell";
import { EditSpaceDialog } from "./EditSpaceDialog";
import { NewSpaceDialog } from "./NewSpaceDialog";
import { SpaceLifecycleDialog } from "./SpaceLifecycleDialog";
import { dashboardSpaceHref, defaultSpaceHrefBuilder, type SpaceHrefBuilder } from "./space-links";

type SpacesPageProps = { tenantID?: string; transcriptionCeiling?: string | null; transcriptionDefaultMode?: string | null; spaceHrefBuilder?: SpaceHrefBuilder };
export type SpaceFilter = "all" | "active" | "archived";

function matchesSpaceFilter(space: Space, filter: SpaceFilter): boolean {
  if (filter === "all") return true;
  return filter === "archived" ? space.archived : !space.archived;
}

export function reconcileSpaceItems(current: Space[], next: Space, filter: SpaceFilter): Space[] {
  const existingIndex = current.findIndex((item) => item.id === next.id);
  if (!matchesSpaceFilter(next, filter)) return existingIndex === -1 ? current : current.filter((item) => item.id !== next.id);
  if (existingIndex === -1) return [next, ...current];
  const updated = [...current];
  updated[existingIndex] = next;
  return updated;
}

export function SpacesPage({ tenantID, transcriptionCeiling, transcriptionDefaultMode, spaceHrefBuilder = defaultSpaceHrefBuilder }: SpacesPageProps) {
  const [spaceItems, setSpaceItems] = useState<Space[]>([]);
  const [filter, setFilter] = useState<SpaceFilter>("all");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(Boolean(tenantID));
  const [loadingMore, setLoadingMore] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [hasMore, setHasMore] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createdSpace, setCreatedSpace] = useState<Space | null>(null);
  const [editSpace, setEditSpace] = useState<Space | null>(null);
  const [lifecycle, setLifecycle] = useState<{ space: Space; action: "archive" | "restore" } | null>(null);

  useEffect(() => {
    if (!tenantID) {
      setSpaceItems([]);
      setLoading(false);
      setError(null);
      return;
    }
    let active = true;
    setLoading(true);
    setError(null);
    setNextCursor(undefined);
    void listSpaces({ tenantID, archived: filter === "all" ? undefined : filter === "archived", pageSize: 50 })
      .then((page) => {
        if (!active) return;
        setSpaceItems(page.spaces);
        setNextCursor(page.pagination.next_cursor ?? undefined);
        setHasMore(page.pagination.has_more);
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setError(cause instanceof DashboardAPIError ? cause.message : "Your Spaces could not load.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [filter, tenantID, reloadNonce]);

  useEffect(() => {
    const refresh = () => setReloadNonce((current) => current + 1);
    window.addEventListener("chalk:spaces-refresh", refresh);
    return () => window.removeEventListener("chalk:spaces-refresh", refresh);
  }, []);

  const visibleSpaces = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return spaceItems;
    return spaceItems.filter((space) => `${space.name} ${space.slug}`.toLowerCase().includes(normalized));
  }, [query, spaceItems]);

  async function loadMore() {
    if (!tenantID || !nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await listSpaces({ tenantID, cursor: nextCursor, archived: filter === "all" ? undefined : filter === "archived", pageSize: 50 });
      setSpaceItems((current) => [...current, ...page.spaces]);
      setNextCursor(page.pagination.next_cursor ?? undefined);
      setHasMore(page.pagination.has_more);
    } catch (cause: unknown) {
      setError(cause instanceof DashboardAPIError ? cause.message : "The next page of Spaces could not load.");
    } finally {
      setLoadingMore(false);
    }
  }

  function addSpace(space: Space) {
    setSpaceItems((current) => reconcileSpaceItems(current, space, filter));
  }

  function replaceSpace(space: Space) {
    setSpaceItems((current) => reconcileSpaceItems(current, space, filter));
    setEditSpace(null);
    setLifecycle(null);
  }

  if (!tenantID) {
    return (
      <div className="dashboard-page resource-page">
        <div className="contract-state">
          <h1>Choose a workspace to see its Spaces.</h1>
        </div>
      </div>
    );
  }

  return (
    <div className="dashboard-page resource-page">
      <ResourcePageHeader title="Spaces" actionLabel="New Space" onAction={() => setCreateOpen(true)} />

      {createdSpace ? (
        <div className="space-created-notice" role="status">
          <span>
            <strong>{createdSpace.name}</strong> is ready.
          </span>
          <a className="dashboard-button secondary" href={spaceHrefBuilder(createdSpace)}>
            Join Space
          </a>
          <button type="button" className="space-created-dismiss" aria-label="Dismiss Space created notice" onClick={() => setCreatedSpace(null)}>
            ×
          </button>
        </div>
      ) : null}

      <div className="resource-toolbar">
        <label className="resource-search">
          <span className="sr-only">Search Spaces</span>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search Spaces" />
        </label>
        <div className="resource-filter" role="group" aria-label="Space status">
          <button type="button" className={filter === "all" ? "is-selected" : ""} onClick={() => setFilter("all")}>
            All
          </button>
          <button type="button" className={filter === "active" ? "is-selected" : ""} onClick={() => setFilter("active")}>
            Active
          </button>
          <button type="button" className={filter === "archived" ? "is-selected" : ""} onClick={() => setFilter("archived")}>
            Archived
          </button>
        </div>
        <span>{spaceItems.length} Spaces</span>
      </div>

      {loading ? <SpaceListState label="Loading Spaces…" /> : null}
      {!loading && error ? <SpaceErrorState message={error} onRetry={() => setReloadNonce((current) => current + 1)} /> : null}
      {!loading && !error && visibleSpaces.length === 0 ? <SpaceEmptyState archived={filter === "archived"} searching={Boolean(query.trim())} hasMore={hasMore} loadingMore={loadingMore} onLoadMore={() => void loadMore()} /> : null}
      {!loading && !error && visibleSpaces.length > 0 ? (
        <>
          <div className="space-list" aria-live="polite">
            {visibleSpaces.map((space) => (
              <SpaceListItem key={space.id} space={space} spaceHrefBuilder={spaceHrefBuilder} onEdit={() => setEditSpace(space)} onArchive={() => setLifecycle({ space, action: "archive" })} onRestore={() => setLifecycle({ space, action: "restore" })} />
            ))}
          </div>
          <SpaceLoadMoreButton hasMore={hasMore} loadingMore={loadingMore} onLoadMore={() => void loadMore()} />
        </>
      ) : null}

      <NewSpaceDialog
        open={createOpen}
        tenantID={tenantID}
        transcriptionCeiling={transcriptionCeiling}
        transcriptionDefaultMode={transcriptionDefaultMode}
        onClose={() => setCreateOpen(false)}
        onCreated={(space) => {
          addSpace(space);
          setCreatedSpace(space);
        }}
      />
      <EditSpaceDialog open={editSpace !== null} tenantID={tenantID} transcriptionCeiling={transcriptionCeiling} space={editSpace} onClose={() => setEditSpace(null)} onSaved={replaceSpace} />
      <SpaceLifecycleDialog open={lifecycle !== null} tenantID={tenantID} space={lifecycle?.space ?? null} action={lifecycle?.action ?? "archive"} onClose={() => setLifecycle(null)} onChanged={replaceSpace} />
    </div>
  );
}

function SpaceListItem({ space, spaceHrefBuilder, onEdit, onArchive, onRestore }: { space: Space; spaceHrefBuilder: SpaceHrefBuilder; onEdit: () => void; onArchive: () => void; onRestore: () => void }) {
  const archived = space.archived;
  return (
    <article className={`space-list-item ${archived ? "is-archived" : ""}`}>
      <a className="space-list-primary-link" href={dashboardSpaceHref(space)}>
        <span className="space-list-copy">
          <h2>{space.name}</h2>
        </span>
      </a>
      <div className="space-list-state">{archived ? <span>Archived</span> : null}</div>
      <time dateTime={space.updated_at}>{relativeDate(space.updated_at)}</time>
      <div className="space-row-actions">
        {!archived ? (
          <a className="dashboard-button secondary" href={spaceHrefBuilder(space)} aria-label={`Join ${space.name}`}>
            Join
          </a>
        ) : null}
        <details className="space-row-menu">
          <summary aria-label={`More actions for ${space.name}`}>
            <Icon name="dots" />
          </summary>
          <div>
            <button type="button" onClick={onEdit}>
              Edit Space
            </button>
            {archived ? (
              <button type="button" onClick={onRestore}>
                Restore Space
              </button>
            ) : (
              <button type="button" onClick={onArchive}>
                Archive Space
              </button>
            )}
          </div>
        </details>
      </div>
    </article>
  );
}

function SpaceListState({ label }: { label: string }) {
  return (
    <div className="contract-state" role="status">
      <p>{label}</p>
    </div>
  );
}

function SpaceErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="contract-state" role="alert">
      <h2>Your Spaces could not load.</h2>
      <p>{message}</p>
      <button type="button" className="dashboard-button secondary" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}

function SpaceEmptyState({ archived, searching, hasMore, loadingMore, onLoadMore }: { archived: boolean; searching: boolean; hasMore: boolean; loadingMore: boolean; onLoadMore: () => void }) {
  if (searching) {
    return (
      <div className="contract-state">
        <h2>{hasMore ? "No match on this page." : "No Spaces match this search."}</h2>
        {hasMore ? <p>Load more Spaces to keep searching.</p> : null}
        <SpaceLoadMoreButton hasMore={hasMore} loadingMore={loadingMore} onLoadMore={onLoadMore} />
      </div>
    );
  }

  return (
    <div className="contract-state">
      <h2>{archived ? "No archived Spaces." : "No Spaces yet."}</h2>
      <p>{archived ? "Spaces you archive appear here, and you can restore them at any time." : "A Space gives you one link that people use to join."}</p>
    </div>
  );
}

function SpaceLoadMoreButton({ hasMore, loadingMore, onLoadMore }: { hasMore: boolean; loadingMore: boolean; onLoadMore: () => void }) {
  if (!hasMore) return null;
  return (
    <button type="button" className="dashboard-button secondary" onClick={onLoadMore} disabled={loadingMore}>
      {loadingMore ? "Loading…" : "Load more Spaces"}
    </button>
  );
}

function relativeDate(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "—";
  const days = Math.max(0, Math.floor((Date.now() - timestamp) / 86_400_000));
  if (days === 0) return "Updated today";
  if (days === 1) return "Updated yesterday";
  return `Updated ${days} days ago`;
}
