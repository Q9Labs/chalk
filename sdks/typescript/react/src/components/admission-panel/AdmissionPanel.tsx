import React, { useEffect, useState } from "react";
import { IconButton, Spinner } from "@q9labsai/chalk-ui";
import { useCan, useParticipants, useSpaceClient } from "../../bindings/hooks";
import { cn } from "../../utils/cn";
import { Cancel01Icon } from "../../utils/icons";
import { Avatar } from "../atomic";
import { ChalkButton } from "../chalk-ui";

export interface AdmissionParticipant {
  id: string;
  displayName: string;
  avatarUrl?: string;
  joinedAt?: Date;
}

export interface AdmissionPanelProps {
  loading?: boolean;
  className?: string;
  onClose?: () => void;
  /** Render the requests as a section inside another surface. */
  inline?: boolean;
}

interface AdmissionPanelSurfaceProps extends AdmissionPanelProps {
  readonly participants: AdmissionParticipant[];
  readonly onAdmit: (id: string) => void | Promise<void>;
  readonly onDeny: (id: string) => void | Promise<void>;
  readonly onAdmitAll?: () => void | Promise<void>;
  readonly onDenyAll?: () => void | Promise<void>;
}

function getWaitingLabel(joinedAt?: Date): string {
  if (!joinedAt) return "Wants to join";
  const minutes = Math.floor((Date.now() - joinedAt.getTime()) / 60_000);
  if (minutes < 1) return "Wants to join";
  return `Wants to join · ${minutes} min`;
}

const AdmissionPanelSurface = React.memo(({ participants, onAdmit, onDeny, onAdmitAll, onDenyAll, loading = false, className, onClose, inline = false }: AdmissionPanelSurfaceProps) => {
  const [, setTick] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => setTick((t) => t + 1), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const perform = async (action: () => void | Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn’t update this join request.");
    } finally {
      setBusy(false);
    }
  };
  const pending = participants.length;

  const list = (
    <>
      {error ? (
        <p role="alert" className="text-sm text-[var(--chalk-danger-text)]">
          {error}
        </p>
      ) : null}
      {pending > 0 ? (
        <div className="flex h-9 items-center justify-between gap-2">
          <span className="text-xs font-semibold text-[var(--chalk-app-text-muted)]" aria-live="polite">
            {pending === 1 ? "1 person waiting" : `${pending} people waiting`}
          </span>
          {loading ? <Spinner size="sm" aria-label="Updating requests" /> : null}
        </div>
      ) : null}

      <ul aria-label="Waiting to join" className="m-0 list-none p-0">
        {pending === 0 ? (
          <li className="py-10 text-center text-sm text-[var(--chalk-app-text-muted)]" role="status">
            No one is waiting to join
          </li>
        ) : (
          participants.map((participant) => (
            <li key={participant.id} className="call-person-row">
              <Avatar name={participant.displayName} src={participant.avatarUrl} size="sm" className="!h-8 !w-8" generated />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-[var(--chalk-app-text)]">
                  <bdi>{participant.displayName}</bdi>
                </p>
                <p className="text-xs text-[var(--chalk-app-text-muted)]">{getWaitingLabel(participant.joinedAt)}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <ChalkButton variant="ghost" className="!h-8 !px-3" disabled={busy || loading} onClick={() => void perform(() => onDeny(participant.id))} aria-label={`Decline ${participant.displayName}`}>
                  Decline
                </ChalkButton>
                <ChalkButton variant="solid" className="!h-8 !px-3" disabled={busy || loading} onClick={() => void perform(() => onAdmit(participant.id))} aria-label={`Let ${participant.displayName} in`}>
                  Let in
                </ChalkButton>
              </div>
            </li>
          ))
        )}
      </ul>
      {pending > 1 && onAdmitAll && onDenyAll ? (
        <div className="grid grid-cols-2 gap-2 pt-2">
          <ChalkButton disabled={busy || loading} onClick={() => void perform(onDenyAll)}>
            Decline all
          </ChalkButton>
          <ChalkButton variant="solid" disabled={busy || loading} onClick={() => void perform(onAdmitAll)}>
            Let everyone in
          </ChalkButton>
        </div>
      ) : null}
    </>
  );

  if (inline) {
    return (
      <section role="region" aria-label="Join requests" className={cn("flex flex-col", className)}>
        {list}
      </section>
    );
  }

  return (
    <div className={cn("flex w-80 flex-col overflow-hidden rounded-[12px] border border-[var(--chalk-app-line-strong)] bg-[var(--chalk-app-panel)] shadow-[var(--chalk-app-shadow-sm)]", className)} role="complementary" aria-label="Join requests">
      <div className="flex items-center justify-between border-b border-[var(--chalk-app-line)] px-4 py-3">
        <h2 className="text-sm font-semibold text-[var(--chalk-app-text)]">Waiting to join</h2>
        {onClose ? <IconButton icon={<Cancel01Icon className="h-4 w-4" />} size="sm" variant="ghost" onClick={onClose} aria-label="Close join requests" className="text-[var(--chalk-app-text-muted)] hover:bg-[var(--chalk-app-control-hover)] hover:text-[var(--chalk-app-text)]" /> : null}
      </div>
      <div className="max-h-80 overflow-y-auto px-4 pb-2">{list}</div>
    </div>
  );
});

AdmissionPanelSurface.displayName = "AdmissionPanelSurface";

export function AdmissionPanel(props: AdmissionPanelProps): React.JSX.Element {
  const client = useSpaceClient();
  const participantsSlice = useParticipants();
  const canManageAdmission = useCan("manageAdmission");
  const participants = canManageAdmission ? participantsSlice.admissionQueue.map((request) => ({ id: request.requestId, displayName: request.displayName })) : [];

  return (
    <AdmissionPanelSurface
      {...props}
      participants={participants}
      onAdmit={(requestId) => client.participants.admit(requestId)}
      onDeny={(requestId) => client.participants.deny(requestId)}
      onAdmitAll={async () => {
        await Promise.all(participants.map((participant) => client.participants.admit(participant.id)));
      }}
      onDenyAll={async () => {
        await Promise.all(participants.map((participant) => client.participants.deny(participant.id)));
      }}
    />
  );
}

AdmissionPanel.displayName = "AdmissionPanel";
