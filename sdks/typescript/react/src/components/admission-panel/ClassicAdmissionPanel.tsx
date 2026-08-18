import React, { useEffect, useState } from "react";
import { Badge, IconButton, Spinner } from "@q9labsai/chalk-ui";
import { useCan, useParticipants, useSpaceClient } from "../../bindings/hooks";
import { Tick01Icon, Cancel01Icon, UserGroupIcon } from "../../utils/icons";
import { Avatar } from "../atomic";
import { cn } from "../../utils/cn";
import type { AdmissionPanelProps, AdmissionParticipant } from "./AdmissionPanel";

interface AdmissionPanelSurfaceProps extends AdmissionPanelProps {
  readonly participants: AdmissionParticipant[];
  readonly onAdmit: (id: string) => void;
  readonly onDeny: (id: string) => void;
  readonly onAdmitAll?: () => void;
  readonly onDenyAll?: () => void;
}

const AdmissionPanelSurface = React.memo(({ participants, onAdmit, onDeny, onAdmitAll, onDenyAll, loading = false, className, onClose }: AdmissionPanelSurfaceProps) => {
  const [, setTick] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 60000);
    return () => clearInterval(timer);
  }, []);

  const getAdmissionLabel = (date?: Date) => {
    if (!date) return "Requested access";
    const minutes = Math.floor((Date.now() - date.getTime()) / 60000);
    if (minutes < 1) return "Joined just now";
    if (minutes === 1) return "Requested 1 min ago";
    return `Requested ${minutes} min ago`;
  };

  const hasPendingAdmission = participants.length > 0;

  return (
    <div className={cn("flex flex-col w-80 overflow-hidden rounded-lg shadow-lg", "bg-[var(--chalk-surface)]", "border border-[var(--chalk-line)]", className)} role="complementary" aria-label="Admission requests">
      <div className={cn("flex items-center justify-between p-4", "border-b border-[var(--chalk-line)]", "bg-[var(--chalk-stage)]")}>
        <div className="flex items-center gap-2" aria-live="polite">
          <h2 className="text-sm font-semibold text-[var(--chalk-text)]">Admission</h2>
          <Badge variant="default" count={participants.length} />
        </div>
        <div className="flex items-center gap-2">
          {loading && <Spinner size="sm" />}
          {onClose ? <IconButton icon={<Cancel01Icon className="w-4 h-4" />} size="sm" variant="ghost" onClick={onClose} aria-label="Close admission" /> : null}
        </div>
      </div>

      {(onAdmitAll || onDenyAll) && (
        <div className="p-2 border-b border-[var(--chalk-line)] flex gap-2">
          {onAdmitAll && (
            <button
              type="button"
              onClick={onAdmitAll}
              disabled={!hasPendingAdmission}
              className={cn(
                "flex-1 px-3 py-1.5 rounded-md text-xs font-medium transition-colors",
                "bg-[var(--chalk-accent)] text-[var(--chalk-accent-text)] hover:bg-[var(--chalk-accent)]",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--chalk-focus)]",
                "disabled:opacity-50 disabled:cursor-not-allowed",
              )}
            >
              Admit All
            </button>
          )}
          {onDenyAll && (
            <button
              type="button"
              onClick={onDenyAll}
              disabled={!hasPendingAdmission}
              className={cn(
                "flex-1 px-3 py-1.5 rounded-md text-xs font-medium transition-colors",
                "bg-[var(--chalk-stage)] text-[var(--chalk-danger)] hover:bg-[var(--chalk-danger-surface)]",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--chalk-focus)]",
                "disabled:opacity-50 disabled:cursor-not-allowed",
              )}
            >
              Deny All
            </button>
          )}
        </div>
      )}

      <ul className="min-h-0 flex-1 overflow-y-auto p-2 space-y-1 list-none m-0" aria-label="Admission requests">
        {!hasPendingAdmission ? (
          <li className="flex flex-col items-center gap-2 p-8 text-center">
            <UserGroupIcon size={24} className="text-[var(--chalk-muted-text)]" />
            <span className="text-sm text-[var(--chalk-muted-text)]">No admission requests</span>
          </li>
        ) : (
          participants.map((p) => (
            <li key={p.id} className={cn("flex items-center justify-between p-2 rounded-md transition-colors", "hover:bg-[var(--chalk-stage)]")}>
              <div className="flex items-center gap-3 min-w-0">
                <Avatar src={p.avatarUrl} name={p.displayName} size="sm" />
                <div className="flex flex-col min-w-0">
                  <span className="text-sm font-medium truncate text-[var(--chalk-text)]" title={p.displayName}>
                    {p.displayName}
                  </span>
                  <span className="text-xs text-[var(--chalk-muted-text)]">{getAdmissionLabel(p.joinedAt)}</span>
                </div>
              </div>

              <div className="flex items-center gap-1 shrink-0">
                <IconButton icon={<Tick01Icon className="w-4 h-4" />} size="sm" variant="ghost" className="text-[var(--chalk-positive)] hover:bg-[var(--chalk-positive)]" onClick={() => onAdmit(p.id)} aria-label={`Admit ${p.displayName}`} />
                <IconButton icon={<Cancel01Icon className="w-4 h-4" />} size="sm" variant="ghost" className="text-[var(--chalk-danger)] hover:bg-[var(--chalk-danger)]" onClick={() => onDeny(p.id)} aria-label={`Deny ${p.displayName}`} />
              </div>
            </li>
          ))
        )}
      </ul>
    </div>
  );
});

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
