import React, { useEffect, useState } from "react";
import { Tick01Icon, Cancel01Icon, UserGroupIcon } from "../../utils/icons";
import { Avatar, IconButton, Badge, Spinner } from "../atomic";
import { cn } from "../../utils/cn";

export interface WaitingParticipant {
  id: string;
  displayName: string;
  avatarUrl?: string;
  joinedAt: Date;
}

export interface WaitingRoomProps {
  participants: WaitingParticipant[];
  onAdmit: (id: string) => void;
  onDeny: (id: string) => void;
  onAdmitAll?: () => void;
  onDenyAll?: () => void;
  loading?: boolean;
  className?: string;
}

export const WaitingRoom = React.memo(({ participants, onAdmit, onDeny, onAdmitAll, onDenyAll, loading = false, className }: WaitingRoomProps) => {
  const [, setTick] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 60000);
    return () => clearInterval(timer);
  }, []);

  const getWaitingLabel = (date: Date) => {
    const minutes = Math.floor((Date.now() - date.getTime()) / 60000);
    if (minutes < 1) return "Joined just now";
    if (minutes === 1) return "Waiting 1 min";
    return `Waiting ${minutes} min`;
  };

  const hasWaiting = participants.length > 0;

  return (
    <div className={cn("flex flex-col w-80 overflow-hidden rounded-lg shadow-lg", "bg-card", "border border-border/50", className)} role="complementary" aria-label="Waiting room">
      <div className={cn("flex items-center justify-between p-4", "border-b border-border/50", "bg-secondary/50")}>
        <div className="flex items-center gap-2" aria-live="polite">
          <h2 className="text-sm font-semibold text-card-foreground">Waiting Room</h2>
          <Badge variant="default" count={participants.length} />
        </div>
        {loading && <Spinner size="sm" />}
      </div>

      {(onAdmitAll || onDenyAll) && (
        <div className="p-2 border-b border-border/50 flex gap-2">
          {onAdmitAll && (
            <button
              type="button"
              onClick={onAdmitAll}
              disabled={!hasWaiting}
              className={cn("flex-1 px-3 py-1.5 rounded-md text-xs font-medium transition-colors", "bg-primary text-primary-foreground hover:bg-primary/90", "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]", "disabled:opacity-50 disabled:cursor-not-allowed")}
            >
              Admit All
            </button>
          )}
          {onDenyAll && (
            <button
              type="button"
              onClick={onDenyAll}
              disabled={!hasWaiting}
              className={cn("flex-1 px-3 py-1.5 rounded-md text-xs font-medium transition-colors", "bg-secondary text-destructive hover:bg-destructive/10", "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]", "disabled:opacity-50 disabled:cursor-not-allowed")}
            >
              Deny All
            </button>
          )}
        </div>
      )}

      <ul className="max-h-80 overflow-y-auto p-2 space-y-1 list-none m-0" aria-label="People waiting to join">
        {!hasWaiting ? (
          <li className="flex flex-col items-center gap-2 p-8 text-center">
            <UserGroupIcon size={24} className="text-muted-foreground/50" />
            <span className="text-sm text-muted-foreground">No one is waiting</span>
          </li>
        ) : (
          participants.map((p) => (
            <li key={p.id} className={cn("flex items-center justify-between p-2 rounded-md transition-colors", "hover:bg-secondary")}>
              <div className="flex items-center gap-3 min-w-0">
                <Avatar src={p.avatarUrl} name={p.displayName} size="sm" />
                <div className="flex flex-col min-w-0">
                  <span className="text-sm font-medium truncate text-card-foreground" title={p.displayName}>
                    {p.displayName}
                  </span>
                  <span className="text-xs text-muted-foreground">{getWaitingLabel(p.joinedAt)}</span>
                </div>
              </div>

              <div className="flex items-center gap-1 shrink-0">
                <IconButton icon={<Tick01Icon className="w-4 h-4" />} size="sm" variant="ghost" className="text-green-600 hover:bg-green-600/10" onClick={() => onAdmit(p.id)} aria-label={`Admit ${p.displayName}`} />
                <IconButton icon={<Cancel01Icon className="w-4 h-4" />} size="sm" variant="ghost" className="text-destructive hover:bg-destructive/10" onClick={() => onDeny(p.id)} aria-label={`Deny ${p.displayName}`} />
              </div>
            </li>
          ))
        )}
      </ul>
    </div>
  );
});

WaitingRoom.displayName = "WaitingRoom";
