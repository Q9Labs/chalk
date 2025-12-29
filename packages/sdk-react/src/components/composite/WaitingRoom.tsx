import { useEffect, useState } from 'react';
import { Check, X } from 'lucide-react';
import { Avatar, IconButton, Badge } from '../atomic';
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
  className?: string;
}

export function WaitingRoom({
  participants,
  onAdmit,
  onDeny,
  onAdmitAll,
  onDenyAll,
  className
}: WaitingRoomProps) {
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
        "flex flex-col bg-chalk-bg-surface border border-chalk-border-subtle rounded-lg shadow-lg w-80 overflow-hidden",
        className
      )}
      role="complementary"
      aria-label="Waiting room"
    >
      <div className="flex items-center justify-between p-4 border-b border-chalk-border-subtle bg-chalk-bg-subtle/50">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-chalk-text-primary">Waiting Room</h2>
          <Badge variant="default" count={participants.length} />
        </div>
      </div>

      <div className="p-2 border-b border-chalk-border-subtle flex gap-2">
        {onAdmitAll && (
          <button
            onClick={onAdmitAll}
            disabled={participants.length === 0}
            className="flex-1 px-3 py-1.5 rounded text-xs font-medium bg-chalk-success text-white hover:bg-opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            Admit All
          </button>
        )}
        {onDenyAll && (
          <button
            onClick={onDenyAll}
            disabled={participants.length === 0}
            className="flex-1 px-3 py-1.5 rounded text-xs font-medium bg-chalk-bg-subtle text-chalk-danger hover:bg-chalk-bg-tertiary disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            Deny All
          </button>
        )}
      </div>

      <div className="max-h-80 overflow-y-auto p-2 space-y-1">
        {participants.length === 0 ? (
          <div className="p-8 text-center text-sm text-chalk-text-muted">
            No one is waiting
          </div>
        ) : (
          participants.map((p) => (
            <div 
              key={p.id}
              className="flex items-center justify-between p-2 rounded-md hover:bg-chalk-bg-subtle transition-colors"
            >
              <div className="flex items-center gap-3 min-w-0">
                <Avatar 
                  src={p.avatarUrl} 
                  name={p.displayName} 
                  size="sm" 
                />
                <div className="flex flex-col min-w-0">
                  <span className="text-sm font-medium text-chalk-text-primary truncate">
                    {p.displayName}
                  </span>
                  <span className="text-xs text-chalk-text-muted">
                    Waiting for {getWaitingTime(p.joinedAt)}
                  </span>
                </div>
              </div>

              <div className="flex items-center gap-1">
                <IconButton
                  icon={<Check className="w-4 h-4" />}
                  size="sm"
                  variant="ghost"
                  className="text-chalk-success hover:bg-chalk-success/10"
                  onClick={() => onAdmit(p.id)}
                  aria-label={`Admit ${p.displayName}`}
                />
                <IconButton
                  icon={<X className="w-4 h-4" />}
                  size="sm"
                  variant="ghost"
                  className="text-chalk-danger hover:bg-chalk-danger/10"
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
}
