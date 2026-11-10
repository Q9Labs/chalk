import { useState } from "react";
import { useCan, useParticipants, useSpaceClient } from "../../bindings/hooks";
import { Cancel01Icon } from "../../utils/icons";
import { Avatar } from "../atomic";
import { ChalkButton } from "../chalk-ui";
import { answerAll } from "./answer-all";

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
