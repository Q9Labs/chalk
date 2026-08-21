import React, { useEffect, useState } from "react";
import { useCan, useParticipants, useSpaceClient } from "../../bindings/hooks";
import { Tick01Icon, Cancel01Icon, UserGroupIcon } from "../../utils/icons";
import { Avatar } from "../atomic";
import { cn } from "../../utils/cn";
import { ChalkBadge, ChalkButton, ChalkChrome, ChalkDivider, ChalkEmptyState, ChalkIconButton, ChalkPanel, ChalkSpinner } from "../chalk-ui";
import { useSkin } from "../skin-context";
import { ClassicAdmissionPanel } from "./ClassicAdmissionPanel";

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
}

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
    <ChalkPanel className={cn("w-80 overflow-hidden rounded-lg p-0 shadow-lg", "bg-[var(--chalk-surface)]", className)} contentClassName="flex h-full min-h-0 flex-col" role="complementary" aria-label="Admission requests">
      <div className="flex h-full min-h-0 w-full flex-col">
        <header className={cn("group relative flex items-center justify-between p-4", "bg-[var(--chalk-stage)]")}>
          <ChalkChrome className="absolute inset-0 h-full w-full" filled fill="var(--chalk-surface, var(--chalk-stage))" part="admission-header" />
          <div className="relative z-[1] flex items-center gap-2" aria-live="polite">
            <h2 className="text-sm font-semibold text-[var(--chalk-text)]">Admission</h2>
            <ChalkBadge count={participants.length} />
          </div>
          <div className="relative z-[1] flex items-center gap-2">
            {loading && <ChalkSpinner className="size-5" />}
            {onClose ? (
              <ChalkIconButton type="button" onClick={onClose} size="sm" className="text-[var(--chalk-muted-text)]" aria-label="Close admission">
                <Cancel01Icon className="h-4 w-4" />
              </ChalkIconButton>
            ) : null}
          </div>
        </header>

        {(onAdmitAll || onDenyAll) && (
          <div className="flex gap-2 p-2">
            {onAdmitAll && (
              <ChalkButton type="button" onClick={onAdmitAll} disabled={!hasPendingAdmission} variant="solid" tone="accent" className="min-h-8 flex-1 rounded-md px-3 py-1.5 text-xs font-medium">
                Admit All
              </ChalkButton>
            )}
            {onDenyAll && (
              <ChalkButton type="button" onClick={onDenyAll} disabled={!hasPendingAdmission} tone="danger" className="min-h-8 flex-1 rounded-md px-3 py-1.5 text-xs font-medium text-[var(--chalk-danger)]">
                Deny All
              </ChalkButton>
            )}
          </div>
        )}
        {(onAdmitAll || onDenyAll) && <ChalkDivider className="m-0 h-3" />}

        <ul className="min-h-0 flex-1 overflow-y-auto p-2 space-y-1 list-none m-0" aria-label="Admission requests">
          {!hasPendingAdmission ? (
            <li>
              <ChalkEmptyState className="px-4 py-8" title="No admission requests">
                <UserGroupIcon size={24} className="mt-2 text-[var(--chalk-muted-text)]" aria-hidden="true" />
              </ChalkEmptyState>
            </li>
          ) : (
            participants.map((p) => (
              <li key={p.id}>
                <ChalkPanel className={cn("rounded-md p-2 transition-colors", "hover:bg-[var(--chalk-stage)]")}>
                  <div className="flex items-center justify-between">
                    <div className="flex min-w-0 items-center gap-3">
                      <Avatar src={p.avatarUrl} name={p.displayName} size="sm" />
                      <div className="flex min-w-0 flex-col">
                        <span className="truncate text-sm font-medium text-[var(--chalk-text)]" title={p.displayName}>
                          {p.displayName}
                        </span>
                        <span className="text-xs text-[var(--chalk-muted-text)]">{getAdmissionLabel(p.joinedAt)}</span>
                      </div>
                    </div>

                    <div className="flex shrink-0 items-center gap-1">
                      <ChalkIconButton size="sm" tone="success" onClick={() => onAdmit(p.id)} aria-label={`Admit ${p.displayName}`}>
                        <Tick01Icon className="w-4 h-4" />
                      </ChalkIconButton>
                      <ChalkIconButton size="sm" tone="danger" onClick={() => onDeny(p.id)} aria-label={`Deny ${p.displayName}`}>
                        <Cancel01Icon className="w-4 h-4" />
                      </ChalkIconButton>
                    </div>
                  </div>
                </ChalkPanel>
              </li>
            ))
          )}
        </ul>
      </div>
    </ChalkPanel>
  );
});

function ChalkAdmissionPanel(props: AdmissionPanelProps): React.JSX.Element {
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

export function AdmissionPanel(props: AdmissionPanelProps): React.JSX.Element {
  const skin = useSkin();
  return skin === "classic" ? <ClassicAdmissionPanel {...props} /> : <ChalkAdmissionPanel {...props} />;
}

AdmissionPanel.displayName = "AdmissionPanel";
