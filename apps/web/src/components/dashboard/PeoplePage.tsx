import { useCallback, useEffect, useRef, useState } from "react";
import { DashboardAPIError, leaveTenant, listMemberships, listTenantInvitations, removeMembership, revokeTenantInvitation, updateMembershipRole, type DashboardMembership, type DashboardPagination, type DashboardTenantInvitation, type TenantRole } from "../../lib/dashboard-api";
import { useDashboardAccount } from "./DashboardAccount";
import { Icon } from "./DashboardShell";
import { InvitePeopleDialog } from "./InvitePeopleDialog";
import { formatDate, roleFromValue, roleLabels, roleName, roles } from "./people-utils";
import { SpaceDialogActions, SpaceDialogError, SpaceDialogFrame, SpaceDialogHeading, useModalDialog } from "./SpaceDialogPrimitives";

const MEMBER_PAGE_SIZE = 50;

type Confirmation = { kind: "remove"; member: DashboardMembership } | { kind: "leave" } | null;

function memberIdentity(member: DashboardMembership, isSelf: boolean) {
  const name = member.user_name.trim();
  const email = member.user_email.trim();
  const label = name || email || member.user_id;
  return { label: isSelf ? `${label} (you)` : label, sublabel: name && email ? email : null };
}

function messageFor(cause: unknown, fallback: string): string {
  return cause instanceof DashboardAPIError ? cause.message : fallback;
}

export function PeoplePage() {
  const { account, current } = useDashboardAccount();
  const tenantID = current.tenant.id;
  const isOwner = current.access.role === "owner";
  const [members, setMembers] = useState<DashboardMembership[]>([]);
  const [pagination, setPagination] = useState<DashboardPagination | null>(null);
  const [membersLoading, setMembersLoading] = useState(true);
  const [membersError, setMembersError] = useState<string | null>(null);
  const [invitations, setInvitations] = useState<DashboardTenantInvitation[]>([]);
  const [invitationsError, setInvitationsError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyID, setBusyID] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [confirmation, setConfirmation] = useState<Confirmation>(null);
  const activeTenantID = useRef(tenantID);
  activeTenantID.current = tenantID;

  const loadMembers = useCallback(
    async (cursor?: string) => {
      setMembersLoading(true);
      setMembersError(null);
      try {
        const page = await listMemberships(tenantID, { cursor, pageSize: MEMBER_PAGE_SIZE });
        if (activeTenantID.current !== tenantID) return;
        setMembers((existing) => (cursor ? [...existing, ...page.memberships] : page.memberships));
        setPagination(page.pagination);
      } catch (cause: unknown) {
        if (activeTenantID.current === tenantID) setMembersError(messageFor(cause, "The member list could not load."));
      } finally {
        if (activeTenantID.current === tenantID) setMembersLoading(false);
      }
    },
    [tenantID],
  );

  const loadInvitations = useCallback(async () => {
    if (!isOwner) return;
    setInvitationsError(null);
    try {
      const list = await listTenantInvitations(tenantID);
      if (activeTenantID.current === tenantID) setInvitations(list);
    } catch (cause: unknown) {
      if (activeTenantID.current === tenantID) setInvitationsError(messageFor(cause, "Pending invitations could not load."));
    }
  }, [isOwner, tenantID]);

  useEffect(() => {
    setMembers([]);
    setInvitations([]);
    setActionError(null);
    void loadMembers();
    void loadInvitations();
  }, [loadMembers, loadInvitations]);

  async function changeRole(member: DashboardMembership, role: TenantRole) {
    if (role === member.role) return;
    setBusyID(member.id);
    setActionError(null);
    try {
      const updated = await updateMembershipRole(tenantID, member.id, role);
      setMembers((existing) => existing.map((item) => (item.id === updated.id ? updated : item)));
    } catch (cause: unknown) {
      setActionError(messageFor(cause, "The Role could not be changed."));
    } finally {
      setBusyID(null);
    }
  }

  async function revoke(invitation: DashboardTenantInvitation) {
    setBusyID(invitation.id);
    setActionError(null);
    try {
      await revokeTenantInvitation(tenantID, invitation.id);
      setInvitations((existing) => existing.filter((item) => item.id !== invitation.id));
    } catch (cause: unknown) {
      setActionError(messageFor(cause, "The invitation could not be revoked."));
    } finally {
      setBusyID(null);
    }
  }

  async function confirm(action: Exclude<Confirmation, null>) {
    if (action.kind === "remove") {
      await removeMembership(tenantID, action.member.id);
      setMembers((existing) => existing.filter((item) => item.id !== action.member.id));
      return;
    }
    await leaveTenant(tenantID);
    window.location.assign("/home");
  }

  return (
    <div className="dashboard-page resource-page">
      <header className="dashboard-page-header resource-heading">
        <div>
          <p className="eyebrow">Tenant access</p>
          <h1>People</h1>
          <p>Everyone with access to {current.tenant.name}, and the invitations still waiting.</p>
        </div>
        {isOwner ? (
          <button className="dashboard-button primary" type="button" onClick={() => setInviteOpen(true)}>
            <Icon name="plus" />
            Invite people
          </button>
        ) : null}
      </header>

      {actionError ? (
        <p role="alert" className="auth-error">
          {actionError}
        </p>
      ) : null}

      <section className="contract-state api-key-panel people-panel" aria-labelledby="members-heading">
        <div className="dashboard-page-header">
          <div>
            <p className="eyebrow">Members</p>
            <h2 id="members-heading">Who can open this Tenant</h2>
            <p>{isOwner ? "Owners can change a Role or remove someone." : "Only an Owner can change Roles or remove people."}</p>
          </div>
        </div>
        {membersLoading && members.length === 0 ? <p className="fixture-note">Loading people…</p> : null}
        {membersError ? (
          <div role="alert" className="contract-rule">
            <strong>Could not load people</strong>
            <span>{membersError}</span>
            <button className="dashboard-button secondary" type="button" onClick={() => void loadMembers()}>
              Try again
            </button>
          </div>
        ) : null}
        {members.length > 0 ? (
          <div className="space-list" aria-label="Members">
            {members.map((member) => {
              const isSelf = member.user_id === account.id;
              const identity = memberIdentity(member, isSelf);
              return (
                <MemberRow
                  key={member.id}
                  member={member}
                  label={identity.label}
                  sublabel={identity.sublabel}
                  isSelf={isSelf}
                  canManage={isOwner}
                  busy={busyID === member.id}
                  onRoleChange={(role) => void changeRole(member, role)}
                  onRemove={() => setConfirmation({ kind: "remove", member })}
                  onLeave={() => setConfirmation({ kind: "leave" })}
                />
              );
            })}
          </div>
        ) : null}
        {pagination?.has_more && pagination.next_cursor ? (
          <button className="dashboard-button secondary" type="button" disabled={membersLoading} onClick={() => void loadMembers(pagination.next_cursor ?? undefined)}>
            Show more people
          </button>
        ) : null}
      </section>

      {isOwner ? (
        <section className="contract-state api-key-panel people-panel" aria-labelledby="invitations-heading">
          <div className="dashboard-page-header">
            <div>
              <p className="eyebrow">Invitations</p>
              <h2 id="invitations-heading">Waiting to join</h2>
              <p>Revoke an invitation to stop its link from working.</p>
            </div>
          </div>
          {invitationsError ? (
            <div role="alert" className="contract-rule">
              <strong>Could not load invitations</strong>
              <span>{invitationsError}</span>
              <button className="dashboard-button secondary" type="button" onClick={() => void loadInvitations()}>
                Try again
              </button>
            </div>
          ) : null}
          {!invitationsError && invitations.length === 0 ? (
            <div className="contract-rule">
              <strong>No pending invitations</strong>
              <span>Invite someone by email and they will appear here until they accept.</span>
            </div>
          ) : null}
          {invitations.length > 0 ? (
            <div className="space-list" aria-label="Pending invitations">
              {invitations.map((invitation) => (
                <article key={invitation.id} className="space-list-item api-key-row people-row">
                  <div className="space-list-copy">
                    <h3>{invitation.email}</h3>
                    <p>{roleName(invitation.role)}</p>
                  </div>
                  <time dateTime={invitation.expires_at}>Expires {formatDate(invitation.expires_at)}</time>
                  <div className="api-key-actions">
                    <button className="dashboard-button secondary" type="button" disabled={busyID === invitation.id} onClick={() => void revoke(invitation)} aria-label={`Revoke invitation for ${invitation.email}`}>
                      Revoke
                    </button>
                  </div>
                </article>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

      {inviteOpen ? <InvitePeopleDialog tenantID={tenantID} onClose={() => setInviteOpen(false)} onIssued={() => void loadInvitations()} /> : null}
      {confirmation ? <ConfirmDialog confirmation={confirmation} tenantName={current.tenant.name} onClose={() => setConfirmation(null)} onConfirm={() => confirm(confirmation)} /> : null}
    </div>
  );
}

function MemberRow({
  member,
  label,
  sublabel,
  isSelf,
  canManage,
  busy,
  onRoleChange,
  onRemove,
  onLeave,
}: {
  member: DashboardMembership;
  label: string;
  sublabel: string | null;
  isSelf: boolean;
  canManage: boolean;
  busy: boolean;
  onRoleChange: (role: TenantRole) => void;
  onRemove: () => void;
  onLeave: () => void;
}) {
  return (
    <article className="space-list-item api-key-row people-row">
      <div className="space-list-copy">
        <h3>{label}</h3>
        {sublabel ? <p>{sublabel}</p> : null}
      </div>
      {canManage ? (
        <select
          className="people-role-select"
          aria-label={`Role for ${label}`}
          value={member.role}
          disabled={busy}
          onChange={(event) => {
            const role = roleFromValue(event.target.value);
            if (role) onRoleChange(role);
          }}
        >
          {roles.map((role) => (
            <option key={role} value={role}>
              {roleLabels[role]}
            </option>
          ))}
        </select>
      ) : (
        <span className="status-idle">{roleName(member.role)}</span>
      )}
      <time dateTime={member.created_at}>Joined {formatDate(member.created_at)}</time>
      <div className="api-key-actions">
        {isSelf ? (
          <button className="dashboard-button secondary" type="button" onClick={onLeave} disabled={busy}>
            Leave Tenant
          </button>
        ) : canManage ? (
          <button className="dashboard-button secondary" type="button" onClick={onRemove} disabled={busy} aria-label={`Remove ${label}`}>
            Remove
          </button>
        ) : null}
      </div>
    </article>
  );
}

function ConfirmDialog({ confirmation, tenantName, onClose, onConfirm }: { confirmation: Exclude<Confirmation, null>; tenantName: string; onClose: () => void; onConfirm: () => Promise<void> }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const leaving = confirmation.kind === "leave";
  useModalDialog(dialogRef, true);

  async function submit() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      onClose();
    } catch (cause: unknown) {
      setError(messageFor(cause, leaving ? "You could not leave this Tenant." : "This person could not be removed."));
      setBusy(false);
    }
  }

  return (
    <SpaceDialogFrame
      dialogRef={dialogRef}
      onClose={onClose}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      ariaLabel={leaving ? "Leave Tenant" : "Remove person"}
    >
      <SpaceDialogHeading title={leaving ? `Leave ${tenantName}?` : "Remove this person?"} description={leaving ? "You will lose access to this Tenant until an Owner invites you again." : "They will lose access to this Tenant right away. They can rejoin only with a new invitation."} />
      <SpaceDialogActions onClose={onClose} disabled={busy} busyLabel={busy ? (leaving ? "Leaving…" : "Removing…") : undefined} submitLabel={leaving ? "Leave Tenant" : "Remove"} />
      <SpaceDialogError message={error} />
    </SpaceDialogFrame>
  );
}
