import { useRef, useState, type FormEvent } from "react";
import { issueTenantInvitation, type DashboardIssuedInvitation, type TenantRole } from "../../lib/dashboard-api";
import { formatDate, roleFromValue, roleLabels, roles } from "./people-utils";
import { runSpaceMutation, SpaceDialogActions, SpaceDialogError, SpaceDialogFrame, SpaceDialogHeading, useModalDialog } from "./SpaceDialogPrimitives";

export function InvitePeopleDialog({ tenantID, onClose, onIssued }: { tenantID: string; onClose: () => void; onIssued: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const linkRef = useRef<HTMLInputElement>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<TenantRole>("collaborator");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<DashboardIssuedInvitation | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "select">("idle");

  useModalDialog(dialogRef, true);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (issued || saving || !email.trim()) return;
    await runSpaceMutation({
      request: () => issueTenantInvitation(tenantID, { email: email.trim(), role }),
      onSuccess: (result) => {
        setIssued(result);
        onIssued();
      },
      setBusy: setSaving,
      setError,
      failureMessage: "We could not create this invitation. Check the email address and try again.",
    });
  }

  async function copyLink(link: string) {
    try {
      await navigator.clipboard.writeText(link);
      setCopyState("copied");
    } catch {
      linkRef.current?.select();
      setCopyState("select");
    }
  }

  return (
    <SpaceDialogFrame dialogRef={dialogRef} onClose={onClose} onSubmit={(event) => void submit(event)} ariaLabel="Invite people" dataFeedbackPrivate>
      {issued ? (
        <>
          <SpaceDialogHeading
            title="Invitation created"
            description={
              issued.email_delivered ? `We sent an email to ${issued.invitation.email}. It expires ${formatDate(issued.invitation.expires_at)}.` : `We could not send an email to ${issued.invitation.email}. Send them this link yourself. It expires ${formatDate(issued.invitation.expires_at)}.`
            }
          />
          {issued.email_delivered ? null : (
            <>
              <label htmlFor="invitation-link">Invitation link</label>
              <input id="invitation-link" ref={linkRef} readOnly value={issued.accept_link} onFocus={(event) => event.currentTarget.select()} />
              <p role="status" className="fixture-note">
                {copyState === "copied" ? "Link copied." : copyState === "select" ? "Copy is blocked here. The link is selected, so copy it by hand." : "Anyone with this link can join as the invited email. Chalk shows it only once."}
              </p>
            </>
          )}
          <div className="dialog-actions">
            {issued.email_delivered ? null : (
              <button type="button" className="dashboard-button secondary" onClick={() => void copyLink(issued.accept_link)}>
                {copyState === "copied" ? "Copied" : "Copy link"}
              </button>
            )}
            <button type="button" className="dashboard-button primary" onClick={onClose}>
              Done
            </button>
          </div>
        </>
      ) : (
        <>
          <SpaceDialogHeading title="Invite people" description="They get access to this Tenant with the Role you choose." />
          <label htmlFor="invite-email">Email</label>
          <input id="invite-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@example.com" autoComplete="off" required autoFocus />
          <label htmlFor="invite-role">Role</label>
          <select id="invite-role" value={role} onChange={(event) => setRole(roleFromValue(event.target.value) ?? "collaborator")}>
            {roles.map((item) => (
              <option key={item} value={item}>
                {roleLabels[item]}
              </option>
            ))}
          </select>
          <SpaceDialogActions onClose={onClose} disabled={!email.trim() || saving} busyLabel={saving ? "Sending…" : undefined} submitLabel="Send invitation" />
          <SpaceDialogError message={error} />
        </>
      )}
    </SpaceDialogFrame>
  );
}
