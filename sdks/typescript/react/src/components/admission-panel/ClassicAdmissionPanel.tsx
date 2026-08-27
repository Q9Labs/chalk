import React, { useEffect, useState } from "react";
import { IconButton, Spinner } from "@q9labsai/chalk-ui";

import { useCan, useParticipants, useSpaceClient } from "../../bindings/hooks";
import { cn } from "../../utils/cn";
import { Cancel01Icon } from "../../utils/icons";
import { Avatar } from "../atomic";
import type { AdmissionPanelProps, AdmissionParticipant } from "./AdmissionPanel";

interface AdmissionPanelSurfaceProps extends AdmissionPanelProps {
  readonly participants: AdmissionParticipant[];
  readonly onAdmit: (id: string) => void;
  readonly onDeny: (id: string) => void;
  readonly onAdmitAll?: () => void;
  readonly onDenyAll?: () => void;
}

const TEXT_BUTTON_CLASS =
  "inline-flex h-7 items-center rounded-[6px] px-2 text-xs font-semibold text-[var(--chalk-app-text-muted)] transition-colors hover:bg-[var(--chalk-app-control-hover)] hover:text-[var(--chalk-app-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--chalk-app-control-active-line)]";
const ADMIT_BUTTON_CLASS =
  "inline-flex h-8 items-center rounded-[7px] border border-transparent bg-[var(--chalk-app-control-active)] px-3 text-[13px] font-semibold text-[var(--chalk-app-control-active-text)] transition-colors hover:border-[var(--chalk-app-control-active-line)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--chalk-app-control-active-line)]";
const DENY_BUTTON_CLASS =
  "inline-flex h-8 items-center rounded-[7px] px-2.5 text-[13px] font-semibold text-[var(--chalk-app-text-muted)] transition-colors hover:bg-[var(--chalk-app-control-hover)] hover:text-[var(--chalk-app-danger)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--chalk-app-control-active-line)]";

function getWaitingLabel(joinedAt?: Date): string {
  if (!joinedAt) return "Waiting to join";
  const minutes = Math.floor((Date.now() - joinedAt.getTime()) / 60_000);
  if (minutes < 1) return "Waiting to join";
  return `Waiting ${minutes} min`;
}

/**
 * Flat list of people waiting at the door. Rendered inline inside the Participants panel
 * (no surrounding card), or as a standalone floating panel when a host mounts it directly.
 */
const AdmissionPanelSurface = React.memo(({ participants, onAdmit, onDeny, onAdmitAll, onDenyAll, loading = false, className, onClose, inline = false }: AdmissionPanelSurfaceProps) => {
  const [, setTick] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => setTick((t) => t + 1), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const pending = participants.length;

  const list = (
    <>
      {pending > 0 ? (
        <div className="flex h-9 items-center justify-between gap-2">
          <span className="text-xs font-semibold uppercase tracking-[0.08em] text-[var(--chalk-app-text-muted)]" aria-live="polite">
            {pending === 1 ? "1 waiting" : `${pending} waiting`}
          </span>
          <div className="flex items-center gap-1">
            {loading ? <Spinner size="sm" aria-label="Updating admission" /> : null}
            {pending > 1 && onAdmitAll ? (
              <button type="button" onClick={onAdmitAll} className={TEXT_BUTTON_CLASS}>
                Admit all
              </button>
            ) : null}
            {pending > 1 && onDenyAll ? (
              <button type="button" onClick={onDenyAll} className={TEXT_BUTTON_CLASS}>
                Deny all
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      <ul aria-label="Waiting to join" className="m-0 list-none divide-y divide-[var(--chalk-app-line)] p-0">
        {pending === 0 ? (
          <li className="py-10 text-center text-sm text-[var(--chalk-app-text-muted)]" role="status">
            No one is waiting to join
          </li>
        ) : (
          participants.map((participant) => (
            <li key={participant.id} className="flex items-center gap-3 py-3">
              <Avatar name={participant.displayName} src={participant.avatarUrl} size="sm" className="h-10 w-10" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-[var(--chalk-app-text)]">{participant.displayName}</p>
                <p className="text-xs text-[var(--chalk-app-text-muted)]">{getWaitingLabel(participant.joinedAt)}</p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <button type="button" onClick={() => onAdmit(participant.id)} className={ADMIT_BUTTON_CLASS} aria-label={`Admit ${participant.displayName}`}>
                  Admit
                </button>
                <button type="button" onClick={() => onDeny(participant.id)} className={DENY_BUTTON_CLASS} aria-label={`Deny ${participant.displayName}`}>
                  Deny
                </button>
              </div>
            </li>
          ))
        )}
      </ul>
    </>
  );

  if (inline) {
    return (
      <section role="region" aria-label="Admission requests" className={cn("flex flex-col", className)}>
        {list}
      </section>
    );
  }

  return (
    <div className={cn("chalk-textured-surface flex w-80 flex-col overflow-hidden rounded-[12px] border border-[var(--chalk-app-line-strong)] bg-[var(--chalk-app-panel)] shadow-[var(--chalk-app-shadow-sm)]", className)} role="complementary" aria-label="Admission requests">
      <div className="flex items-center justify-between border-b border-[var(--chalk-app-line)] px-4 py-3">
        <h2 className="text-sm font-semibold text-[var(--chalk-app-text)]">Waiting to join</h2>
        {onClose ? <IconButton icon={<Cancel01Icon className="h-4 w-4" />} size="sm" variant="ghost" onClick={onClose} aria-label="Close admission" className="text-[var(--chalk-app-text-muted)] hover:bg-[var(--chalk-app-control-hover)] hover:text-[var(--chalk-app-text)]" /> : null}
      </div>
      <div className="max-h-80 overflow-y-auto px-4 pb-2">{list}</div>
    </div>
  );
});

AdmissionPanelSurface.displayName = "AdmissionPanelSurface";

export function ClassicAdmissionPanel(props: AdmissionPanelProps): React.JSX.Element {
  const client = useSpaceClient();
  const participantsSlice = useParticipants();
  const canManageAdmission = useCan("manageAdmission");
  const participants = canManageAdmission ? participantsSlice.admissionQueue.map((request) => ({ id: request.requestId, displayName: request.displayName })) : [];

  return (
    <AdmissionPanelSurface
      {...props}
      participants={participants}
      onAdmit={(requestId) => void client.participants.admit(requestId)}
      onDeny={(requestId) => void client.participants.deny(requestId)}
      onAdmitAll={() => {
        for (const participant of participants) void client.participants.admit(participant.id);
      }}
      onDenyAll={() => {
        for (const participant of participants) void client.participants.deny(participant.id);
      }}
    />
  );
}

ClassicAdmissionPanel.displayName = "AdmissionPanel";
