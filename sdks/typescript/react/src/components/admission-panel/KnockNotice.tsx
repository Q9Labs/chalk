import { useState } from "react";
import { useCan, useParticipants, useSpaceClient } from "../../bindings/hooks";
import { Cancel01Icon } from "../../utils/icons";
import { Avatar } from "../atomic";
import { ChalkButton } from "../chalk-ui";
import { answerAll } from "./answer-all";

const styles = `.chalk-knock-notice {
  position: absolute;
  z-index: 46;
  top: 60px;
  right: var(--space-3);
  width: 348px;
  display: grid;
  gap: var(--space-3);
  padding: var(--space-3);
  border-radius: var(--corner-2xl);
  background: var(--chalk-popover);
  border: 1px solid var(--chalk-line-strong);
  box-shadow: var(--chalk-shadow);
}
.chalk-knock-top {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}
.chalk-knock-text {
  display: grid;
  min-width: 0;
  flex: 1;
}
.chalk-knock-text b {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--type-body-lg);
  font-weight: 600;
}
.chalk-knock-text span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--type-body-sm);
  color: var(--chalk-muted-text);
}
.chalk-knock-stack {
  display: inline-flex;
  flex: none;
}
.chalk-knock-stack > * + * {
  margin-inline-start: calc(var(--space-2-5) * -1);
}
.chalk-knock-stack > * {
  /* token-ratchet-ignore: ring drawn with box-shadow, the design system has no ring token */
  box-shadow: 0 0 0 2px var(--chalk-popover);
}
.chalk-knock-hide {
  align-self: start;
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  flex: none;
  border-radius: 50%;
  color: var(--chalk-muted-text);
}
.chalk-knock-hide:hover {
  background: var(--chalk-hover);
  color: var(--chalk-text);
}
.chalk-knock-hide svg {
  width: 16px;
  height: 16px;
}
.chalk-knock-notice > p {
  font-size: var(--type-body-sm);
  color: var(--chalk-danger-text);
}
.chalk-knock-actions {
  display: flex;
  gap: var(--space-2);
}
.chalk-knock-actions .chalk-pill-button {
  flex: 1;
  height: 36px;
}
@media (max-width: 767px) {
  .chalk-knock-notice {
    left: var(--space-3);
    right: var(--space-3);
    width: auto;
    top: 64px;
  }
  .chalk-knock-actions .chalk-pill-button {
    height: 44px;
  }
}
`;

export interface KnockRequest {
  readonly id: string;
  readonly displayName: string;
}

/** One request reads as a person, two or more as one group, so a flood of knocks never makes more than one notice. */
export type KnockSummary = { readonly kind: "one"; readonly request: KnockRequest } | { readonly kind: "several"; readonly count: number; readonly faces: readonly KnockRequest[]; readonly names: string };

export function summarizeKnocks(requests: readonly KnockRequest[]): KnockSummary | null {
  const [first] = requests;
  if (!first) return null;
  if (requests.length === 1) return { kind: "one", request: first };
  return { kind: "several", count: requests.length, faces: requests.slice(0, 3), names: requests.map((request) => request.displayName).join(", ") };
}

export interface KnockNoticeSurfaceProps {
  readonly requests: readonly KnockRequest[];
  readonly onAdmit: (id: string) => Promise<unknown>;
  readonly onDeny: (id: string) => Promise<unknown>;
  readonly onReview: () => void;
  readonly onHide: () => void;
}

/** A quiet notice for the host: it never takes focus and stays until the request is answered. */
export function KnockNoticeSurface({ requests, onAdmit, onDeny, onReview, onHide }: KnockNoticeSurfaceProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const summary = summarizeKnocks(requests);
  if (!summary) return null;
  const answer = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn’t answer this request.");
    } finally {
      setBusy(false);
    }
  };
  const ids = requests.map((request) => request.id);
  return (
    <div className="chalk-knock-notice" role="status" aria-live="polite" data-part="knock-notice">
      <style>{styles}</style>
      <div className="chalk-knock-top">
        {summary.kind === "one" ? (
          <>
            <Avatar name={summary.request.displayName} size="md" generated />
            <span className="chalk-knock-text">
              <b dir="auto">{summary.request.displayName}</b>
              <span>Wants to join</span>
            </span>
          </>
        ) : (
          <>
            <span className="chalk-knock-stack">
              {summary.faces.map((face) => (
                <Avatar key={face.id} name={face.displayName} size="sm" generated />
              ))}
            </span>
            <span className="chalk-knock-text">
              <b>{summary.count} people want to join</b>
              <span dir="auto">{summary.names}</span>
            </span>
          </>
        )}
        <button type="button" className="chalk-knock-hide" aria-label="Hide notice" onClick={onHide}>
          <Cancel01Icon aria-hidden="true" />
        </button>
      </div>
      {error ? <p role="alert">{error}</p> : null}
      <div className="chalk-knock-actions">
        {summary.kind === "one" ? (
          <>
            <ChalkButton disabled={busy} onClick={() => void answer(() => onDeny(summary.request.id))} aria-label={`Decline ${summary.request.displayName}`}>
              Decline
            </ChalkButton>
            <ChalkButton variant="solid" disabled={busy} onClick={() => void answer(() => onAdmit(summary.request.id))} aria-label={`Let ${summary.request.displayName} in`}>
              Let in
            </ChalkButton>
          </>
        ) : (
          <>
            <ChalkButton onClick={onReview}>Review</ChalkButton>
            <ChalkButton variant="solid" disabled={busy} onClick={() => void answer(() => answerAll(ids, onAdmit, "let in"))}>
              Let everyone in
            </ChalkButton>
          </>
        )}
      </div>
    </div>
  );
}

export interface KnockNoticeProps {
  /** Request ids whose notice the host hid. A request that arrives later shows the notice again. */
  readonly hiddenIds: ReadonlySet<string>;
  readonly onReview: () => void;
  readonly onHide: (ids: readonly string[]) => void;
}

export function KnockNotice({ hiddenIds, onReview, onHide }: KnockNoticeProps) {
  const client = useSpaceClient();
  const canManageAdmission = useCan("manageAdmission");
  const { admissionQueue } = useParticipants();
  const requests = admissionQueue.map((request) => ({ id: request.requestId, displayName: request.displayName }));
  if (!canManageAdmission || requests.every((request) => hiddenIds.has(request.id))) return null;
  return <KnockNoticeSurface requests={requests} onAdmit={(id) => client.participants.admit(id)} onDeny={(id) => client.participants.deny(id)} onReview={onReview} onHide={() => onHide(requests.map((request) => request.id))} />;
}
