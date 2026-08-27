import React, { useEffect, useState } from "react";
import { useCan, useParticipants, useSpaceClient } from "../../bindings/hooks";
import { Cancel01Icon, UserAdd01Icon } from "../../utils/icons";
import { Avatar } from "../atomic";
import { cn } from "../../utils/cn";
import { ChalkBadge, ChalkButton, ChalkIconButton, ChalkPanel, ChalkSpinner } from "../chalk-ui";
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
  /** Render the requests as a section inside another surface. */
  inline?: boolean;
}

interface AdmissionPanelSurfaceProps extends AdmissionPanelProps {
  readonly participants: AdmissionParticipant[];
  readonly onAdmit: (id: string) => void;
  readonly onDeny: (id: string) => void;
  readonly onAdmitAll?: () => void;
  readonly onDenyAll?: () => void;
}

const ROW_CLASS = "flex min-h-14 items-center gap-3 px-1 py-2";
const BULK_BUTTON_CLASS = "h-8 min-h-0 rounded-[8px] px-2.5 text-xs font-semibold";

function getWaitingLabel(date?: Date): string {
  if (!date) return "Waiting to join";
  const minutes = Math.floor((Date.now() - date.getTime()) / 60000);
  if (minutes < 1) return "Waiting to join";
  return `Waiting ${minutes} min`;
}

/**
 * Admission lives inside the Participants panel as a quiet section: a title with a live count,
 * one 56px row per waiting person with a decisive Admit and a quiet Deny, and bulk actions only
 * once there is more than one request. Standalone use wraps the same section in a panel.
 */
const AdmissionPanelSurface = React.memo(({ participants, onAdmit, onDeny, onAdmitAll, onDenyAll, loading = false, className, onClose, inline = false }: AdmissionPanelSurfaceProps) => {
  const [, setTick] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 60000);
    return () => clearInterval(timer);
  }, []);

  const pending = participants.length;
  const showBulkActions = pending > 1 && (onAdmitAll !== undefined || onDenyAll !== undefined);

  const section = (
    <>
      <header className="flex min-h-10 items-center justify-between gap-3 px-1">
        <div className="flex min-w-0 items-center gap-2" aria-live="polite">
          <h3 className="text-sm font-semibold text-[var(--chalk-app-text)]">Admission</h3>
          <ChalkBadge tone="accent" count={pending} className="!min-h-5 !min-w-5 !px-1.5 !text-[11px] !text-[var(--chalk-app-control-active-text)]" />
          {loading ? <ChalkSpinner className="size-4" /> : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {showBulkActions && onAdmitAll ? (
            <ChalkButton variant="ghost" onClick={onAdmitAll} className={BULK_BUTTON_CLASS}>
              Admit all
            </ChalkButton>
          ) : null}
          {showBulkActions && onDenyAll ? (
            <ChalkButton variant="ghost" onClick={onDenyAll} className={cn(BULK_BUTTON_CLASS, "text-[var(--chalk-app-text-muted)] hover:text-[var(--chalk-app-danger)]")}>
              Deny all
            </ChalkButton>
          ) : null}
          {onClose ? (
            <ChalkIconButton type="button" onClick={onClose} size="sm" className="text-[var(--chalk-app-text-muted)] hover:text-[var(--chalk-app-text)]" aria-label="Close admission">
              <Cancel01Icon size={16} />
            </ChalkIconButton>
          ) : null}
        </div>
      </header>

      {pending === 0 ? (
        <p role="status" className="flex min-h-11 items-center gap-2.5 px-1 text-[13px] text-[var(--chalk-app-text-muted)]">
          <UserAdd01Icon size={16} className="shrink-0 opacity-70" aria-hidden="true" />
          No one is waiting to join
        </p>
      ) : (
        <ul className={cn("m-0 list-none p-0", !inline && "max-h-80 overflow-y-auto")} aria-label="Admission requests">
          {participants.map((p) => (
            <li key={p.id} className={ROW_CLASS}>
              <Avatar src={p.avatarUrl} name={p.displayName} size="sm" />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-semibold text-[var(--chalk-app-text)]" title={p.displayName}>
                  {p.displayName}
                </span>
                <span className="text-xs text-[var(--chalk-app-text-muted)]">{getWaitingLabel(p.joinedAt)}</span>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <ChalkButton variant="solid" tone="accent" onClick={() => onAdmit(p.id)} className="h-8 min-h-0 rounded-[8px] px-3 text-xs font-semibold !text-[var(--chalk-app-control-active-text)]" aria-label={`Admit ${p.displayName}`}>
                  Admit
                </ChalkButton>
                <ChalkIconButton size="sm" onClick={() => onDeny(p.id)} className="text-[var(--chalk-app-text-muted)] hover:text-[var(--chalk-app-danger)]" aria-label={`Deny ${p.displayName}`}>
                  <Cancel01Icon size={16} />
                </ChalkIconButton>
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );

  if (inline) {
    return (
      <section role="region" aria-label="Admission requests" className={cn("mb-2 border-b border-[var(--chalk-app-line)] pb-3", className)}>
        {section}
      </section>
    );
  }

  return (
    <ChalkPanel className={cn("w-80 rounded-lg bg-[var(--chalk-app-panel)] p-3 shadow-[var(--chalk-app-shadow-sm)]", className)} contentClassName="flex min-h-0 flex-col" role="complementary" aria-label="Admission requests">
      {section}
    </ChalkPanel>
  );
});

AdmissionPanelSurface.displayName = "AdmissionPanelSurface";

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
