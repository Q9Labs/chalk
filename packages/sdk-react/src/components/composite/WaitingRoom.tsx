import React, { useEffect, useState } from 'react';
import { Tick01Icon, Cancel01Icon } from '../../utils/icons';
import { Avatar, IconButton, Badge, Spinner } from '../atomic';
import { cn } from '../../utils/cn';

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

export const WaitingRoom = React.memo(({
  participants,
  onAdmit,
  onDeny,
  onAdmitAll,
  onDenyAll,
  loading = false,
  className
}: WaitingRoomProps) => {
  const [, setTick] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setTick(t => t + 1), 60000);
    return () => clearInterval(timer);
  }, []);

  const getWaitingTime = (date: Date) => {
    const diff = Math.floor((new Date().getTime() - date.getTime()) / 60000);
    if (diff < 1) return 'Just now';
    return `${diff} min`;
  };

  return (
    <div
      className={cn(
        "flex flex-col w-80 overflow-hidden rounded-lg shadow-lg",
        "bg-[var(--card,var(--chalk-bg-surface))]",
        "border border-[var(--border,var(--chalk-border-subtle))]",
        className
      )}
      role="complementary"
      aria-label="Waiting room"
    >
      <div className={cn(
        "flex items-center justify-between p-4",
        "border-b border-[var(--border,var(--chalk-border-subtle))]",
        "bg-[var(--muted,var(--chalk-bg-subtle))]/50"
      )}>
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-[var(--card-foreground,var(--chalk-text-primary))]">Waiting Room</h2>
          <Badge variant="default" count={participants.length} />
        </div>
        {loading && <Spinner size="sm" />}
      </div>

      <div className="p-2 border-b border-[var(--border,var(--chalk-border-subtle))] flex gap-2">
        {onAdmitAll && (
          <button
            onClick={onAdmitAll}
            disabled={participants.length === 0}
            className={cn(
              "flex-1 px-3 py-1.5 rounded text-xs font-medium transition-colors",
              "bg-green-600 text-white hover:bg-green-700",
              "disabled:opacity-50 disabled:cursor-not-allowed"
            )}
          >
            Admit All
          </button>
        )}
        {onDenyAll && (
          <button
            onClick={onDenyAll}
            disabled={participants.length === 0}
            className={cn(
              "flex-1 px-3 py-1.5 rounded text-xs font-medium transition-colors",
              "bg-[var(--muted,var(--chalk-bg-subtle))] text-[var(--destructive,var(--chalk-danger))]",
              "hover:bg-[var(--accent,var(--chalk-bg-tertiary))]",
              "disabled:opacity-50 disabled:cursor-not-allowed"
            )}
          >
            Deny All
          </button>
        )}
      </div>

      <div className="max-h-80 overflow-y-auto p-2 space-y-1">
        {participants.length === 0 ? (
          <div className="p-8 text-center text-sm text-[var(--muted-foreground,var(--chalk-text-muted))]">
            No one is waiting
          </div>
        ) : (
          participants.map((p) => (
            <div
              key={p.id}
              className={cn(
                "flex items-center justify-between p-2 rounded-md transition-colors",
                "hover:bg-[var(--muted,var(--chalk-bg-subtle))]"
              )}
            >
              <div className="flex items-center gap-3 min-w-0">
                <Avatar
                  src={p.avatarUrl}
                  name={p.displayName}
                  size="sm"
                />
                <div className="flex flex-col min-w-0">
                  <span className="text-sm font-medium truncate text-[var(--card-foreground,var(--chalk-text-primary))]">
                    {p.displayName}
                  </span>
                  <span className="text-xs text-[var(--muted-foreground,var(--chalk-text-muted))]">
                    Waiting for {getWaitingTime(p.joinedAt)}
                  </span>
                </div>
              </div>

              <div className="flex items-center gap-1">
                <IconButton
                  icon={<Tick01Icon className="w-4 h-4" />}
                  size="sm"
                  variant="ghost"
                  className="text-green-600 hover:bg-green-600/10"
                  onClick={() => onAdmit(p.id)}
                  aria-label={`Admit ${p.displayName}`}
                />
                <IconButton
                  icon={<Cancel01Icon className="w-4 h-4" />}
                  size="sm"
                  variant="ghost"
                  className="text-[var(--destructive,var(--chalk-danger))] hover:bg-[var(--destructive,var(--chalk-danger))]/10"
                  onClick={() => onDeny(p.id)}
                  aria-label={`Deny ${p.displayName}`}
                />
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
});

WaitingRoom.displayName = 'WaitingRoom';
