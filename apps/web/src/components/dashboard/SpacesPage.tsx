import { useEffect, useMemo, useState } from "react";
import { DashboardAPIError, listSpaces, type Space } from "../../lib/dashboard-api";
import { Icon, ResourcePageHeader } from "./DashboardShell";
import { EditSpaceDialog } from "./EditSpaceDialog";
import { NewSpaceDialog } from "./NewSpaceDialog";
import { SpaceLifecycleDialog } from "./SpaceLifecycleDialog";

type SpacesPageProps = { tenantID?: string };
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

export function SpacesPage({ tenantID }: SpacesPageProps) {
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
        setError(cause instanceof DashboardAPIError ? cause.message : "The Spaces inventory could not load.");
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
          <span>
            <Icon name="spaces" />
          </span>
          <p className="eyebrow">Tenant context needed</p>
          <h1>Select a Tenant to see its Spaces.</h1>
          <p>Space identity and access are always scoped to the selected Tenant.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="dashboard-page resource-page">
      <ResourcePageHeader eyebrow="Durable collaboration places" title="Spaces" description="Places for recurring Episodes, Members, and shared context." actionLabel="New Space" onAction={() => setCreateOpen(true)} />

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
      {!loading && !error && visibleSpaces.length === 0 ? <SpaceEmptyState archived={filter === "archived"} searching={Boolean(query.trim())} hasMore={hasMore} loadingMore={loadingMore} onCreate={() => setCreateOpen(true)} onLoadMore={() => void loadMore()} /> : null}
      {!loading && !error && visibleSpaces.length > 0 ? (
        <>
          <div className="space-list" aria-live="polite">
            {visibleSpaces.map((space, index) => (
              <SpaceListItem key={space.id} space={space} accent={accentFor(index)} onEdit={() => setEditSpace(space)} onArchive={() => setLifecycle({ space, action: "archive" })} onRestore={() => setLifecycle({ space, action: "restore" })} />
            ))}
          </div>
          <SpaceLoadMoreButton hasMore={hasMore} loadingMore={loadingMore} onLoadMore={() => void loadMore()} />
        </>
      ) : null}

      <NewSpaceDialog open={createOpen} tenantID={tenantID} onClose={() => setCreateOpen(false)} onCreated={addSpace} />
      <EditSpaceDialog open={editSpace !== null} tenantID={tenantID} space={editSpace} onClose={() => setEditSpace(null)} onSaved={replaceSpace} />
      <SpaceLifecycleDialog open={lifecycle !== null} tenantID={tenantID} space={lifecycle?.space ?? null} action={lifecycle?.action ?? "archive"} onClose={() => setLifecycle(null)} onChanged={replaceSpace} />
    </div>
  );
}

function SpaceListItem({ space, accent, onEdit, onArchive, onRestore }: { space: Space; accent: "green" | "blue" | "yellow" | "pink"; onEdit: () => void; onArchive: () => void; onRestore: () => void }) {
  const archived = space.archived;
  return (
    <article className={`space-list-item accent-${accent} ${archived ? "is-archived" : ""}`}>
      <span className="space-glyph" aria-hidden="true">
        {space.name.slice(0, 1).toUpperCase()}
      </span>
      <div className="space-list-copy">
        <h2>{space.name}</h2>
        <p>
          <code>{space.slug}</code>
        </p>
      </div>
      <div className="space-list-state">
        <span className={archived ? "status-idle" : "status-live"}>{archived ? "Archived" : "Ready to join"}</span>
        <small>{archived ? "New joins paused" : "Dormant until an Episode starts"}</small>
      </div>
      <time dateTime={space.updated_at}>{relativeDate(space.updated_at)}</time>
      <div className="space-row-actions">
        <button type="button" className="dashboard-button secondary" onClick={onEdit}>
          Edit
        </button>
        {archived ? (
          <button type="button" className="dashboard-button secondary" onClick={onRestore}>
            Restore
          </button>
        ) : (
          <button type="button" className="dashboard-button secondary" onClick={onArchive}>
            Archive
          </button>
        )}
      </div>
    </article>
  );
}

function SpaceListState({ label }: { label: string }) {
  return (
    <div className="contract-state" role="status">
      <span>
        <Icon name="spaces" />
      </span>
      <p>{label}</p>
    </div>
  );
}

function SpaceErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="contract-state" role="alert">
      <span>
        <Icon name="activity" />
      </span>
      <p className="eyebrow">Spaces unavailable</p>
      <h2>We could not load your Spaces.</h2>
      <p>{message}</p>
      <button type="button" className="dashboard-button secondary" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}

function SpaceEmptyState({ archived, searching, hasMore, loadingMore, onCreate, onLoadMore }: { archived: boolean; searching: boolean; hasMore: boolean; loadingMore: boolean; onCreate: () => void; onLoadMore: () => void }) {
  if (searching) {
    return (
      <div className="contract-state">
        <span>
          <Icon name="spaces" />
        </span>
        <p className="eyebrow">{hasMore ? "More Spaces available" : "No matching Spaces"}</p>
        <h2>{hasMore ? "No match on this page." : "Try another search."}</h2>
        <p>{hasMore ? "Load the next page to keep searching this Tenant." : "No Space name or slug matches this search."}</p>
        <SpaceLoadMoreButton hasMore={hasMore} loadingMore={loadingMore} onLoadMore={onLoadMore} />
      </div>
    );
  }

  return (
    <div className="contract-state">
      <span>
        <Icon name="spaces" />
      </span>
      <p className="eyebrow">{archived ? "No archived Spaces" : "A calm place to start"}</p>
      <h2>{archived ? "Nothing is archived." : "Create your first Space."}</h2>
      <p>{archived ? "Archived Spaces remain readable and can be restored whenever the work returns." : "Spaces are durable homes for Episodes and the people who carry them forward."}</p>
      {!archived ? (
        <button type="button" className="dashboard-button primary" onClick={onCreate}>
          Create a Space
        </button>
      ) : null}
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

function accentFor(index: number): "green" | "blue" | "yellow" | "pink" {
  return (["green", "blue", "yellow", "pink"] as const)[index % 4]!;
}

function relativeDate(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "—";
  const days = Math.max(0, Math.floor((Date.now() - timestamp) / 86_400_000));
  if (days === 0) return "Updated today";
  if (days === 1) return "Updated yesterday";
  return `Updated ${days} days ago`;
}
