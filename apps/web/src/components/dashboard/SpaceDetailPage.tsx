import { useEffect, useRef, useState } from "react";
import {
  approveSpacePublicAdmissionRequest,
  DashboardAPIError,
  denySpacePublicAdmissionRequest,
  getSpace,
  getSpacePublicInvite,
  listEpisodes,
  listSpacePublicAdmissionRequests,
  rotateSpacePublicInvite,
  updateSpacePublicInvite,
  type DashboardEpisode,
  type DashboardEpisodePage,
  type DashboardPublicAdmissionRequest,
  type DashboardPublicAdmissionRequestPage,
  type DashboardSpacePublicInvite,
  type Space,
} from "../../lib/dashboard-api";
import { AnimatedCopy01Icon, type AnimatedCopy01IconHandle } from "@q9labsai/chalk-react/utils";
import { EditSpaceDialog } from "./EditSpaceDialog";
import { SpaceDialogActions, SpaceDialogError, SpaceDialogFrame, useModalDialog } from "./SpaceDialogPrimitives";
import { SpaceLifecycleDialog } from "./SpaceLifecycleDialog";
import { defaultSpaceHrefBuilder, episodeHistoryHref, publicSpaceHrefBuilder } from "./space-links";
import { formatDateTime, formatJSON, statusLabel } from "./episode-utils";

export type SpaceDetailClient = {
  getSpace: (input: { tenantID: string; spaceID: string }) => Promise<Space>;
  listEpisodes: (input: { tenantID: string; spaceID?: string; pageSize?: number }) => Promise<DashboardEpisodePage>;
  getSpacePublicInvite?: (input: { tenantID: string; spaceID: string }) => Promise<DashboardSpacePublicInvite>;
  updateSpacePublicInvite?: (input: { tenantID: string; spaceID: string; enabled: boolean }) => Promise<DashboardSpacePublicInvite>;
  rotateSpacePublicInvite?: (input: { tenantID: string; spaceID: string }) => Promise<DashboardSpacePublicInvite>;
  listSpacePublicAdmissionRequests?: (input: { tenantID: string; spaceID: string }) => Promise<DashboardPublicAdmissionRequestPage>;
  approveSpacePublicAdmissionRequest?: (input: { tenantID: string; spaceID: string; requestHandle: string }) => Promise<DashboardPublicAdmissionRequest>;
  denySpacePublicAdmissionRequest?: (input: { tenantID: string; spaceID: string; requestHandle: string }) => Promise<DashboardPublicAdmissionRequest>;
};

const defaultSpaceDetailClient: SpaceDetailClient = {
  getSpace,
  listEpisodes,
  getSpacePublicInvite,
  updateSpacePublicInvite,
  rotateSpacePublicInvite,
  listSpacePublicAdmissionRequests,
  approveSpacePublicAdmissionRequest,
  denySpacePublicAdmissionRequest,
};

type SpaceDetailPageProps = {
  tenantID: string;
  spaceID: string;
  client?: SpaceDetailClient;
};

type LoadState = "loading" | "ready" | "error" | "not-found";
type PublicInviteState = "loading" | "ready" | "error" | "archived" | "members-only" | "unavailable";
type AdmissionRequestsState = "loading" | "ready" | "error" | "archived" | "members-only" | "not-applicable" | "unavailable";

const PUBLIC_ADMISSION_REQUEST_POLL_MS = 2_000;

export function SpaceDetailPage({ tenantID, spaceID, client = defaultSpaceDetailClient }: SpaceDetailPageProps) {
  const [space, setSpace] = useState<Space | null>(null);
  const [episodes, setEpisodes] = useState<DashboardEpisode[]>([]);
  const [state, setState] = useState<LoadState>("loading");
  const [error, setError] = useState<string | null>(null);
  const [reloadGeneration, setReloadGeneration] = useState(0);
  const [publicInvite, setPublicInvite] = useState<DashboardSpacePublicInvite | null>(null);
  const [publicInviteState, setPublicInviteState] = useState<PublicInviteState>("loading");
  const [publicInviteError, setPublicInviteError] = useState<string | null>(null);
  const [publicInviteReloadGeneration, setPublicInviteReloadGeneration] = useState(0);
  const [admissionRequestsReloadGeneration, setAdmissionRequestsReloadGeneration] = useState(0);
  const [pendingRequests, setPendingRequests] = useState<DashboardPublicAdmissionRequest[]>([]);
  const [admissionRequestsState, setAdmissionRequestsState] = useState<AdmissionRequestsState>("loading");
  const [admissionRequestsError, setAdmissionRequestsError] = useState<string | null>(null);
  const [inviteMutation, setInviteMutation] = useState<"disable" | "enable" | "rotate" | null>(null);
  const [inviteMutationError, setInviteMutationError] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const [rotateOpen, setRotateOpen] = useState(false);
  const [requestAction, setRequestAction] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [lifecycle, setLifecycle] = useState<"archive" | "restore" | null>(null);

  useEffect(() => {
    let active = true;
    setState("loading");
    setError(null);
    setSpace(null);
    setEpisodes([]);
    setPublicInvite(null);
    setPublicInviteState("loading");
    setPublicInviteError(null);
    setCopyState("idle");
    setInviteMutationError(null);

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

  useEffect(() => {
    if (state !== "ready" || !space) return;

    let active = true;
    const mode = readAdmissionMode(space.admission_policy);
    setPublicInvite(null);
    setPublicInviteError(null);

    if (space.archived) {
      setPublicInviteState("archived");
      return () => {
        active = false;
      };
    }

    if (mode === "members_only") {
      setPublicInviteState("members-only");
      return () => {
        active = false;
      };
    }

    if (!client.getSpacePublicInvite) {
      setPublicInviteState("unavailable");
    } else {
      setPublicInviteState("loading");
      void client
        .getSpacePublicInvite({ tenantID, spaceID: space.id })
        .then((nextInvite) => {
          if (!active) return;
          setPublicInvite(nextInvite);
          setPublicInviteState("ready");
        })
        .catch((cause: unknown) => {
          if (!active) return;
          setPublicInviteError(spaceDetailError(cause));
          setPublicInviteState("error");
        });
    }

    return () => {
      active = false;
    };
  }, [client, publicInviteReloadGeneration, space, spaceID, state, tenantID]);

  useEffect(() => {
    if (state !== "ready" || !space) return;

    let active = true;
    let pollTimeout: ReturnType<typeof setTimeout> | undefined;
    const currentSpace = space;
    const mode = readAdmissionMode(currentSpace.admission_policy);
    setPendingRequests([]);
    setAdmissionRequestsError(null);

    if (currentSpace.archived) {
      setAdmissionRequestsState("archived");
      return () => {
        active = false;
      };
    }

    if (mode === "members_only") {
      setAdmissionRequestsState("members-only");
      return () => {
        active = false;
      };
    }

    if (mode !== "knock") {
      setAdmissionRequestsState("not-applicable");
      return () => {
        active = false;
      };
    }

    const listAdmissionRequests = client.listSpacePublicAdmissionRequests;
    if (!listAdmissionRequests) {
      setAdmissionRequestsState("unavailable");
      return () => {
        active = false;
      };
    }

    setAdmissionRequestsState("loading");

    const pollAdmissionRequests = async (): Promise<void> => {
      try {
        const page = await listAdmissionRequests({ tenantID, spaceID: currentSpace.id });
        if (!active) return;
        setPendingRequests(page.requests);
        setAdmissionRequestsState("ready");
        setAdmissionRequestsError(null);
      } catch (cause: unknown) {
        if (!active) return;
        setAdmissionRequestsError(spaceDetailError(cause));
        setAdmissionRequestsState("error");
      }

      if (active) pollTimeout = setTimeout(() => void pollAdmissionRequests(), PUBLIC_ADMISSION_REQUEST_POLL_MS);
    };

    void pollAdmissionRequests();

    return () => {
      active = false;
      if (pollTimeout !== undefined) clearTimeout(pollTimeout);
    };
  }, [admissionRequestsReloadGeneration, client, space, state, tenantID]);

  function replaceSpace(nextSpace: Space) {
    setSpace(nextSpace);
    setEditOpen(false);
    setLifecycle(null);
  }

  async function setPublicInviteEnabled(enabled: boolean) {
    if (!space || !client.updateSpacePublicInvite || inviteMutation) return;
    setInviteMutation(enabled ? "enable" : "disable");
    setInviteMutationError(null);
    setCopyState("idle");
    try {
      const nextInvite = await client.updateSpacePublicInvite({ tenantID, spaceID: space.id, enabled });
      setPublicInvite(nextInvite);
    } catch (cause: unknown) {
      setInviteMutationError(spaceDetailError(cause));
    } finally {
      setInviteMutation(null);
    }
  }

  async function rotatePublicInvite() {
    if (!space || !client.rotateSpacePublicInvite || inviteMutation) return;
    setInviteMutation("rotate");
    setInviteMutationError(null);
    setCopyState("idle");
    try {
      const nextInvite = await client.rotateSpacePublicInvite({ tenantID, spaceID: space.id });
      setPublicInvite(nextInvite);
      setRotateOpen(false);
    } catch (cause: unknown) {
      setInviteMutationError(spaceDetailError(cause));
    } finally {
      setInviteMutation(null);
    }
  }

  async function copyPublicInvite(): Promise<boolean> {
    const href = publicInvite ? publicSpaceHrefBuilder(publicInvite) : undefined;
    if (!href || !globalThis.navigator?.clipboard?.writeText) {
      setCopyState("error");
      return false;
    }
    try {
      await globalThis.navigator.clipboard.writeText(href);
      setCopyState("copied");
      return true;
    } catch {
      setCopyState("error");
      return false;
    }
  }

  async function decideAdmissionRequest(request: DashboardPublicAdmissionRequest, decision: "approve" | "deny") {
    if (!space || requestAction) return;
    const handler = decision === "approve" ? client.approveSpacePublicAdmissionRequest : client.denySpacePublicAdmissionRequest;
    if (!handler) return;
    setRequestAction(`${decision}:${request.request_handle}`);
    setAdmissionRequestsError(null);
    try {
      await handler({ tenantID, spaceID: space.id, requestHandle: request.request_handle });
      setPendingRequests((current) => current.filter((item) => item.request_handle !== request.request_handle));
    } catch (cause: unknown) {
      setAdmissionRequestsError(spaceDetailError(cause));
    } finally {
      setRequestAction(null);
    }
  }

  if (state === "loading") return <SpaceDetailState kind="loading" />;
  if (state === "not-found") return <SpaceDetailState kind="not-found" />;
  if (state === "error") {
    return <SpaceDetailState kind="error" message={error ?? "The Space could not load."} onRetry={() => setReloadGeneration((current) => current + 1)} />;
  }
  if (!space) return <SpaceDetailState kind="not-found" />;

  const archived = space.archived;
  const admissionMode = readAdmissionMode(space.admission_policy);
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

      <PublicInvitePanel
        state={publicInviteState}
        invite={publicInvite}
        error={publicInviteError}
        mutation={inviteMutation}
        mutationError={inviteMutationError}
        copyState={copyState}
        onCopy={copyPublicInvite}
        onDisable={() => void setPublicInviteEnabled(false)}
        onEnable={() => void setPublicInviteEnabled(true)}
        onRotate={() => setRotateOpen(true)}
        onRetry={() => setPublicInviteReloadGeneration((current) => current + 1)}
      />

      {admissionMode === "knock" ? (
        <AdmissionRequestsPanel
          state={admissionRequestsState}
          requests={pendingRequests}
          error={admissionRequestsError}
          requestAction={requestAction}
          onApprove={(request) => void decideAdmissionRequest(request, "approve")}
          onDeny={(request) => void decideAdmissionRequest(request, "deny")}
          onRetry={() => setAdmissionRequestsReloadGeneration((current) => current + 1)}
        />
      ) : null}

      <section className="space-detail-episodes" aria-labelledby="space-episodes-heading">
        <div className="space-detail-section-heading">
          <div>
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
      <RotatePublicInviteDialog open={rotateOpen} spaceName={space.name} busy={inviteMutation === "rotate"} error={inviteMutationError} onClose={() => setRotateOpen(false)} onConfirm={() => void rotatePublicInvite()} />
    </div>
  );
}

type PanelState = PublicInviteState | AdmissionRequestsState;

function PanelStateMessages({
  headingID,
  heading,
  description,
  state,
  loadingMessage,
  archivedMessage,
  membersOnlyMessage,
  unavailableMessage,
  error,
  errorFallback,
  onRetry,
}: {
  headingID: string;
  heading: string;
  description: string;
  state: PanelState;
  loadingMessage: string;
  archivedMessage: string;
  membersOnlyMessage: string;
  unavailableMessage: string;
  error: string | null;
  errorFallback: string;
  onRetry?: () => void;
}) {
  return (
    <>
      <div className="space-detail-section-heading">
        <div>
          <h2 id={headingID}>{heading}</h2>
          <p>{description}</p>
        </div>
      </div>

      {state === "loading" ? (
        <p className="space-detail-inline-state" role="status" aria-busy="true" aria-live="polite">
          {loadingMessage}
        </p>
      ) : null}
      {state === "archived" ? <p className="space-detail-inline-state">{archivedMessage}</p> : null}
      {state === "members-only" ? <p className="space-detail-inline-state">{membersOnlyMessage}</p> : null}
      {state === "unavailable" ? <p className="space-detail-inline-state">{unavailableMessage}</p> : null}
      {state === "error" ? (
        <div className="space-detail-inline-error" role="alert">
          <p>{error ?? errorFallback}</p>
          {onRetry ? (
            <button className="dashboard-button secondary" type="button" onClick={onRetry}>
              Try again
            </button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

function PublicInvitePanel({
  state,
  invite,
  error,
  mutation,
  mutationError,
  copyState,
  onCopy,
  onDisable,
  onEnable,
  onRotate,
  onRetry,
}: {
  state: PublicInviteState;
  invite: DashboardSpacePublicInvite | null;
  error: string | null;
  mutation: "disable" | "enable" | "rotate" | null;
  mutationError: string | null;
  copyState: "idle" | "copied" | "error";
  onCopy: () => Promise<boolean>;
  onDisable: () => void;
  onEnable: () => void;
  onRotate: () => void;
  onRetry: () => void;
}) {
  const copyIconRef = useRef<AnimatedCopy01IconHandle>(null);

  const handleCopy = async () => {
    if (await onCopy()) copyIconRef.current?.startAnimation();
  };

  return (
    <section className="space-detail-public-invite" aria-labelledby="space-public-link-heading">
      <PanelStateMessages
        headingID="space-public-link-heading"
        heading="Public link"
        description="Share this link with people outside your Tenant when you want them to enter this Space."
        state={state}
        loadingMessage="Loading public link…"
        archivedMessage="Public links are unavailable while this Space is archived."
        membersOnlyMessage="Public links are unavailable for members-only Spaces."
        unavailableMessage="Public link management is not available for this Space yet."
        error={error}
        errorFallback="We could not load the public link."
        onRetry={onRetry}
      />

      {state === "ready" ? (
        <div className="space-detail-public-invite-body">
          {publicInviteURL(invite) ? (
            <div className="space-detail-public-link-field">
              <label htmlFor="space-public-link">Public URL</label>
              <div className="space-detail-public-link-controls">
                <input id="space-public-link" readOnly value={publicInviteURL(invite)} />
                <button
                  className="dashboard-button secondary"
                  type="button"
                  onClick={() => void handleCopy()}
                  onMouseEnter={() => copyIconRef.current?.startAnimation()}
                  onFocus={() => copyIconRef.current?.startAnimation()}
                  disabled={mutation !== null}
                  aria-label={copyState === "copied" ? "Public link copied" : "Copy link"}
                >
                  <AnimatedCopy01Icon ref={copyIconRef} size={16} aria-hidden="true" onMouseEnter={() => copyIconRef.current?.startAnimation()} />
                  Copy link
                </button>
              </div>
            </div>
          ) : (
            <p className="space-detail-inline-state">The server has not materialized a public URL for this Space yet.</p>
          )}

          <div className="space-detail-public-invite-meta">
            <span className={`space-detail-public-invite-status ${invite?.enabled ? "is-enabled" : "is-disabled"}`} role="status">
              {invite?.enabled ? "Enabled" : "Disabled"}
            </span>
            {invite?.generation ? <span>Generation {invite.generation}</span> : null}
          </div>

          <div className="space-detail-public-invite-actions" aria-label="Public link actions">
            {invite?.enabled ? (
              <button className="dashboard-button secondary" type="button" onClick={onDisable} disabled={mutation !== null}>
                {mutation === "disable" ? "Disabling…" : "Disable link"}
              </button>
            ) : (
              <button className="dashboard-button secondary" type="button" onClick={onEnable} disabled={mutation !== null}>
                {mutation === "enable" ? "Re-enabling…" : "Re-enable link"}
              </button>
            )}
            <button className="dashboard-button secondary" type="button" onClick={onRotate} disabled={mutation !== null}>
              Rotate link
            </button>
          </div>

          {copyState === "copied" ? (
            <p className="space-detail-inline-success" role="status">
              Public link copied.
            </p>
          ) : null}
          {copyState === "error" ? (
            <p className="space-detail-inline-error" role="alert">
              We could not copy the public link. Copy it from the field instead.
            </p>
          ) : null}
          {mutationError ? (
            <p className="space-detail-inline-error" role="alert">
              {mutationError}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function AdmissionRequestsPanel({
  state,
  requests,
  error,
  requestAction,
  onApprove,
  onDeny,
  onRetry,
}: {
  state: AdmissionRequestsState;
  requests: DashboardPublicAdmissionRequest[];
  error: string | null;
  requestAction: string | null;
  onApprove: (request: DashboardPublicAdmissionRequest) => void;
  onDeny: (request: DashboardPublicAdmissionRequest) => void;
  onRetry?: () => void;
}) {
  return (
    <section className="space-detail-admission-requests" aria-labelledby="space-admission-requests-heading">
      <PanelStateMessages
        headingID="space-admission-requests-heading"
        heading="Pending join requests"
        description="Approve or deny people waiting to enter this Space."
        state={state}
        loadingMessage="Loading pending requests…"
        archivedMessage="Join requests are paused while this Space is archived."
        membersOnlyMessage="Join requests are unavailable for members-only Spaces."
        unavailableMessage="Pending request management is not available for this Space yet."
        error={error}
        errorFallback="We could not load pending requests."
        onRetry={onRetry}
      />
      {state === "ready" && requests.length === 0 ? <p className="space-detail-inline-state">No pending join requests.</p> : null}
      {state === "ready" && requests.length > 0 ? (
        <ul className="space-detail-admission-request-list">
          {requests.map((request) => {
            const busy = requestAction === `approve:${request.request_handle}` || requestAction === `deny:${request.request_handle}`;
            return (
              <li key={request.request_handle} className="space-detail-admission-request">
                <div>
                  <strong>{request.display_name}</strong>
                  <small>Requested {formatDateTime(request.requested_at)}</small>
                </div>
                <div className="space-detail-admission-request-actions">
                  <button className="dashboard-button secondary" type="button" onClick={() => onApprove(request)} disabled={requestAction !== null}>
                    {busy && requestAction?.startsWith("approve:") ? "Approving…" : `Approve ${request.display_name}`}
                  </button>
                  <button className="dashboard-button secondary" type="button" onClick={() => onDeny(request)} disabled={requestAction !== null}>
                    {busy && requestAction?.startsWith("deny:") ? "Denying…" : `Deny ${request.display_name}`}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
      {error && state === "ready" ? (
        <p className="space-detail-inline-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function RotatePublicInviteDialog({ open, spaceName, busy, error, onClose, onConfirm }: { open: boolean; spaceName: string; busy: boolean; error: string | null; onClose: () => void; onConfirm: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useModalDialog(dialogRef, open);

  return (
    <SpaceDialogFrame
      dialogRef={dialogRef}
      onClose={onClose}
      onSubmit={(event) => {
        event.preventDefault();
        onConfirm();
      }}
    >
      <h2>Rotate public link?</h2>
      <p className="dialog-intro">The current link will stop working as soon as you rotate it. Anyone using the old link must receive the new one.</p>
      <p className="fixture-note">
        <strong>{spaceName}</strong>
      </p>
      <SpaceDialogActions onClose={onClose} disabled={busy} busyLabel={busy ? "Rotating…" : undefined} submitLabel="Rotate link" />
      <SpaceDialogError message={error} />
    </SpaceDialogFrame>
  );
}

function publicInviteURL(invite: DashboardSpacePublicInvite | null): string | undefined {
  return invite ? publicSpaceHrefBuilder(invite) : undefined;
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

function readAdmissionMode(value: unknown): "open" | "knock" | "members_only" | undefined {
  if (!value || typeof value !== "object" || !("mode" in value)) return undefined;
  const mode = value.mode;
  return mode === "open" || mode === "knock" || mode === "members_only" ? mode : undefined;
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
