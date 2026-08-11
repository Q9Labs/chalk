import { useEffect, useMemo, useState } from "react";
import { DashboardAPIError, listSpaces, type Space } from "../../lib/dashboard-api";
import { Icon, ResourcePageHeader } from "./DashboardShell";
import { EditSpaceDialog } from "./EditSpaceDialog";
import { NewSpaceDialog } from "./NewSpaceDialog";
import { SpaceLifecycleDialog } from "./SpaceLifecycleDialog";
import { dashboardSpaceHref, defaultSpaceHrefBuilder, type SpaceHrefBuilder } from "./space-links";

type SpacesPageProps = { tenantID?: string; spaceHrefBuilder?: SpaceHrefBuilder };
export type SpaceFilter = "all" | "active" | "archived";
type AdmissionFilter = "all" | "open" | "knock" | "members_only";

function matchesSpaceFilter(space: Space, filter: SpaceFilter): boolean {
  if (filter === "all") return true;
  return filter === "archived" ? space.archived : !space.archived;
}

function admissionMode(space: Space): AdmissionFilter {
  const value = space.admission_policy;
  if (value && typeof value === "object" && "mode" in value) {
    const mode = (value as { mode?: unknown }).mode;
    if (mode === "knock" || mode === "members_only") return mode;
  }
  return "open";
}

export function reconcileSpaceItems(current: Space[], next: Space, filter: SpaceFilter): Space[] {
  const existingIndex = current.findIndex((item) => item.id === next.id);
  if (!matchesSpaceFilter(next, filter)) return existingIndex === -1 ? current : current.filter((item) => item.id !== next.id);
  if (existingIndex === -1) return [next, ...current];
  const updated = [...current];
  updated[existingIndex] = next;
  return updated;
}

export function SpacesPage({ tenantID, spaceHrefBuilder = defaultSpaceHrefBuilder }: SpacesPageProps) {
  const [spaceItems, setSpaceItems] = useState<Space[]>([]);
  const [filter, setFilter] = useState<SpaceFilter>("all");
  const [admissionFilter, setAdmissionFilter] = useState<AdmissionFilter>("all");
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
    return spaceItems.filter((space) => {
      const matchesQuery = !normalized || `${space.name} ${space.slug}`.toLowerCase().includes(normalized);
      const matchesAdmission = admissionFilter === "all" || admissionMode(space) === admissionFilter;
      return matchesQuery && matchesAdmission;
    });
  }, [admissionFilter, query, spaceItems]);

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
    <div className="dashboard-page resource-page spaces-page">
      <ResourcePageHeader title="Spaces" description="Create, manage, and join your collaboration Spaces." actionLabel="New Space" onAction={() => setCreateOpen(true)} />

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

      <div className="spaces-toolbar" aria-label="Space filters">
        <label className="spaces-search">
          <span className="sr-only">Search Spaces</span>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search spaces…" />
        </label>
        <label className="spaces-filter">
          <span className="sr-only">Space status</span>
          <select value={filter} onChange={(event) => setFilter(event.target.value as SpaceFilter)}>
            <option value="all">All status</option>
            <option value="active">Active</option>
            <option value="archived">Archived</option>
          </select>
        </label>
        <label className="spaces-filter">
          <span className="sr-only">Admission</span>
          <select value={admissionFilter} onChange={(event) => setAdmissionFilter(event.target.value as AdmissionFilter)}>
            <option value="all">Admission</option>
            <option value="open">Open</option>
            <option value="knock">Ask to join</option>
            <option value="members_only">Members only</option>
          </select>
        </label>
      </div>

      {loading ? <SpaceListState label="Loading Spaces…" /> : null}
      {!loading && error ? <SpaceErrorState message={error} onRetry={() => setReloadNonce((current) => current + 1)} /> : null}
      {!loading && !error && visibleSpaces.length === 0 ? <SpaceEmptyState archived={filter === "archived"} searching={Boolean(query.trim()) || admissionFilter !== "all"} hasMore={hasMore} loadingMore={loadingMore} onCreate={() => setCreateOpen(true)} onLoadMore={() => void loadMore()} /> : null}
      {!loading && !error && visibleSpaces.length > 0 ? (
        <>
          <div className="spaces-table-wrap" aria-live="polite">
            <table className="spaces-table">
              <caption className="sr-only">Spaces inventory</caption>
              <thead>
                <tr>
                  <th scope="col">Space</th>
                  <th scope="col">Status</th>
                  <th scope="col">Participants</th>
                  <th scope="col">Last Episode</th>
                  <th scope="col">Created</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {visibleSpaces.map((space, index) => (
                  <SpaceTableRow key={space.id} space={space} accent={accentFor(index)} spaceHrefBuilder={spaceHrefBuilder} onEdit={() => setEditSpace(space)} onArchive={() => setLifecycle({ space, action: "archive" })} onRestore={() => setLifecycle({ space, action: "restore" })} />
                ))}
              </tbody>
            </table>
            <div className="spaces-table-footer">
              <span>
                Showing 1–{visibleSpaces.length} of {visibleSpaces.length} Spaces
              </span>
              <SpaceLoadMoreButton hasMore={hasMore} loadingMore={loadingMore} onLoadMore={() => void loadMore()} />
            </div>
          </div>
        </>
      ) : null}

      <NewSpaceDialog
        open={createOpen}
        tenantID={tenantID}
        onClose={() => setCreateOpen(false)}
        onCreated={(space) => {
          addSpace(space);
          setCreatedSpace(space);
        }}
      />
      <EditSpaceDialog open={editSpace !== null} tenantID={tenantID} space={editSpace} onClose={() => setEditSpace(null)} onSaved={replaceSpace} />
      <SpaceLifecycleDialog open={lifecycle !== null} tenantID={tenantID} space={lifecycle?.space ?? null} action={lifecycle?.action ?? "archive"} onClose={() => setLifecycle(null)} onChanged={replaceSpace} />
    </div>
  );
}

function SpaceTableRow({ space, accent, spaceHrefBuilder, onEdit, onArchive, onRestore }: { space: Space; accent: "green" | "blue" | "yellow" | "pink"; spaceHrefBuilder: SpaceHrefBuilder; onEdit: () => void; onArchive: () => void; onRestore: () => void }) {
  const archived = space.archived;
  return (
    <tr className={`spaces-table-row accent-${accent} ${archived ? "is-archived" : ""}`}>
      <th scope="row">
        <a className="spaces-table-primary-link" href={dashboardSpaceHref(space)} aria-label={`View details for ${space.name}`}>
          <span className="space-glyph" aria-hidden="true">
            {space.name.slice(0, 1).toUpperCase()}
          </span>
          <span className="spaces-table-copy">
            <h2>{space.name}</h2>
            <code>{space.slug}</code>
          </span>
        </a>
      </th>
      <td>
        <span className={`spaces-table-status ${archived ? "is-idle" : "is-live"}`}>
          <span aria-hidden="true" />
          {archived ? "Archived" : "Ready to join"}
        </span>
      </td>
      <td className="spaces-table-muted">—</td>
      <td>
        <span className="spaces-table-last-episode">No Episodes yet</span>
        <small>Space updated {relativeDate(space.updated_at).replace("Updated ", "")}</small>
      </td>
      <td>
        <time dateTime={space.created_at}>{createdDate(space.created_at)}</time>
      </td>
      <td>
        <div className="spaces-table-actions">
          {!archived ? (
            <a className="dashboard-button primary" href={spaceHrefBuilder(space)}>
              Join Space
            </a>
          ) : null}
          <a className="dashboard-button secondary" href={dashboardSpaceHref(space)}>
            View details
          </a>
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
      </td>
    </tr>
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

function createdDate(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "—";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(timestamp);
}
