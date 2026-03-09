import { useState, useRef, useEffect } from "react";
import { MoreVerticalIcon, MicrophoneOff01Icon, Edit02Icon } from "../../../utils/icons";
import { Avatar, AudioIndicator, HandRaiseIndicator, IconButton } from "../../atomic";
import { cn } from "../../../utils/cn";
import type { Participant, ParticipantListVariant } from "./ParticipantList";
import { ParticipantOptionsMenu } from "./ParticipantOptionsMenu";

export interface ParticipantRowProps {
  participant: Participant;
  variant: ParticipantListVariant;
  canManageParticipants: boolean;
  onMuteParticipant?: (id: string) => void;
  onRemoveParticipant?: (id: string) => void;
  onMakeHost?: (id: string) => void;
  onMakeCoHost?: (id: string) => void;
  onUpdateDisplayName?: (name: string) => void;
  participantVolumes?: ReadonlyMap<string, number>;
  onParticipantVolumeChange?: (id: string, volume: number) => void;
  menuOpen: boolean;
  onMenuToggle: () => void;
  onMenuClose: () => void;
}

export function ParticipantRow({ participant, variant, canManageParticipants, onMuteParticipant, onRemoveParticipant, onMakeHost, onMakeCoHost, onUpdateDisplayName, participantVolumes, onParticipantVolumeChange, menuOpen, onMenuToggle, onMenuClose }: ParticipantRowProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState(participant.displayName);
  const inputRef = useRef<HTMLInputElement>(null);

  const hasVolumeControl = !!participantVolumes && !!onParticipantVolumeChange;
  const showMenuButton = canManageParticipants || hasVolumeControl || (participant.isLocal && !!onUpdateDisplayName);

  useEffect(() => {
    if (isEditing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [isEditing]);

  const handleSave = () => {
    if (editName.trim() && editName !== participant.displayName) {
      onUpdateDisplayName?.(editName.trim());
    }
    setIsEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleSave();
    if (e.key === "Escape") {
      setEditName(participant.displayName);
      setIsEditing(false);
    }
  };

  const optionsButtonClassName = variant === "mobile" ? "text-muted-foreground hover:text-foreground" : variant === "sidebar" ? "opacity-70 hover:opacity-100 text-muted-foreground hover:text-foreground" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100";

  return (
    <div className={cn("group flex items-center justify-between p-3 rounded-lg hover:bg-muted/50 transition-colors relative", variant === "sidebar" && "hover:bg-muted/50")}>
      <div className="flex items-center gap-3 min-w-0 flex-1">
        <div className="relative">
          <Avatar name={participant.displayName} size="sm" className={cn(variant === "sidebar" && "w-9 h-9")} />
          {participant.isHandRaised && <HandRaiseIndicator raised={true} size="sm" className="-top-1 -right-1" />}
        </div>

        <div className="flex flex-col min-w-0 flex-1">
          <div className="flex items-center gap-1.5 w-full">
            {isEditing ? (
              <div className="flex items-center gap-1 flex-1">
                <input
                  ref={inputRef}
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  onKeyDown={handleKeyDown}
                  onBlur={handleSave}
                  className={cn("text-sm font-normal bg-background border border-primary/30 rounded px-1.5 py-0.5 outline-none w-full min-w-0 focus:border-primary", variant === "sidebar" ? "text-card-foreground" : "text-chalk-text-primary")}
                />
              </div>
            ) : (
              <span
                className={cn("text-sm font-normal truncate max-w-[140px]", variant === "sidebar" ? "text-card-foreground" : "text-chalk-text-primary")}
                onClick={() => participant.isLocal && onUpdateDisplayName && setIsEditing(true)}
                title={participant.isLocal && onUpdateDisplayName ? "Click to edit" : undefined}
              >
                {participant.displayName}
              </span>
            )}
            {participant.isLocal && !isEditing && (
              <span className={cn("text-xs flex items-center gap-1 shrink-0", variant === "sidebar" ? "text-muted-foreground" : "text-chalk-text-muted")}>
                (you)
                {onUpdateDisplayName && (
                  <button onClick={() => setIsEditing(true)} className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 hover:text-primary">
                    <Edit02Icon className="w-3 h-3" />
                  </button>
                )}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            {participant.role && participant.role !== "participant" && (
              <span className={cn("text-[11px] tracking-normal font-normal", variant === "sidebar" ? "text-muted-foreground" : "text-chalk-text-secondary bg-chalk-bg-subtle px-1.5 py-0.5 rounded")}>{variant === "sidebar" && participant.role === "host" ? "Meeting Host" : participant.role}</span>
            )}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-1 shrink-0">
        {variant === "sidebar" ? (
          participant.isMuted ? (
            <div className="bg-[#dc2626]/20 p-1.5 rounded-full">
              <MicrophoneOff01Icon className="w-3.5 h-3.5 text-[#dc2626]" />
            </div>
          ) : null
        ) : (
          <AudioIndicator muted={participant.isMuted} level={participant.isMuted ? 0 : 0.5} className={cn(participant.isMuted && "text-chalk-error-main")} />
        )}

        {showMenuButton && !isEditing && (
          <div className="relative">
            <IconButton icon={<MoreVerticalIcon className="w-4 h-4" />} size="sm" variant="ghost" className={optionsButtonClassName} onClick={onMenuToggle} aria-label={`Options for ${participant.displayName}`} />

            {menuOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={onMenuClose} />
                <div className={cn("absolute right-0 top-full mt-1 w-64 rounded-lg shadow-xl z-20 overflow-hidden py-1", variant === "sidebar" ? "bg-popover/95 backdrop-blur-xl border border-border/50" : "bg-chalk-bg-surface border border-chalk-border-subtle")}>
                  <ParticipantOptionsMenu
                    participant={participant}
                    variant={variant}
                    canManageParticipants={canManageParticipants}
                    onClose={onMenuClose}
                    onMuteParticipant={onMuteParticipant}
                    onRemoveParticipant={onRemoveParticipant}
                    onMakeHost={onMakeHost}
                    onMakeCoHost={onMakeCoHost}
                    onEditName={
                      participant.isLocal
                        ? () => {
                            setIsEditing(true);
                            onMenuClose();
                          }
                        : undefined
                    }
                    participantVolumes={participantVolumes}
                    onParticipantVolumeChange={onParticipantVolumeChange}
                  />
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
