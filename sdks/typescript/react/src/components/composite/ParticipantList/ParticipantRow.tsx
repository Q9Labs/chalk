import { useState, useRef, useEffect } from "react";
import { MoreVerticalIcon, MicrophoneOff01Icon, Edit02Icon } from "../../../utils/icons";
import { Avatar, AudioIndicator, HandRaiseIndicator, IconButton } from "../../atomic";
import { cn } from "../../../utils/cn";
import type { ParticipantGradientPreference } from "../../../utils/colorGenerator";
import type { ParticipantListParticipant, ParticipantListVariant } from "./ParticipantList";
import { ParticipantOptionsMenu } from "./ParticipantOptionsMenu";

export interface ParticipantRowProps {
  participant: ParticipantListParticipant;
  variant: ParticipantListVariant;
  canManageParticipants: boolean;
  onMuteParticipant?: (id: string) => void;
  onRequestUnmute?: (id: string) => void;
  onStopParticipantCamera?: (id: string) => void;
  onRequestStartCamera?: (id: string) => void;
  onRemoveParticipant?: (id: string) => void;
  onMakeHost?: (id: string) => void;
  onMakeCoHost?: (id: string) => void;
  onUpdateDisplayName?: (name: string) => void;
  participantVolumes?: ReadonlyMap<string, number>;
  onParticipantVolumeChange?: (id: string, volume: number) => void;
  participantGradientPreference?: ParticipantGradientPreference;
  menuOpen: boolean;
  onMenuToggle: () => void;
  onMenuClose: () => void;
}

export function ParticipantRow({
  participant,
  variant,
  canManageParticipants,
  onMuteParticipant,
  onRequestUnmute,
  onStopParticipantCamera,
  onRequestStartCamera,
  onRemoveParticipant,
  onMakeHost,
  onMakeCoHost,
  onUpdateDisplayName,
  participantVolumes,
  onParticipantVolumeChange,
  participantGradientPreference,
  menuOpen,
  onMenuToggle,
  onMenuClose,
}: ParticipantRowProps) {
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
    <div className={cn("group relative flex items-center justify-between rounded-lg p-3 transition-colors hover:bg-muted/50", variant === "sidebar" && "rounded-none px-1 py-3.5 hover:bg-[#f7f6f2]")}>
      <div className="flex items-center gap-3 min-w-0 flex-1">
        <div className="relative">
          <Avatar name={participant.displayName} src={participant.avatarUrl} size="sm" generated={Boolean(participant.avatarUrl)} className={cn(variant === "sidebar" && "h-10 w-10")} gradientPreference={participantGradientPreference} />
          {participant.isHandRaised && <HandRaiseIndicator raised={true} size="sm" className="-right-0.5 -top-0.5" />}
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
                className={cn("max-w-[140px] truncate text-sm", variant === "sidebar" ? "font-semibold text-[#202329]" : "font-normal text-chalk-text-primary")}
                onClick={() => participant.isLocal && onUpdateDisplayName && setIsEditing(true)}
                title={participant.isLocal && onUpdateDisplayName ? "Click to edit" : undefined}
              >
                {participant.displayName}
              </span>
            )}
            {participant.isLocal && !isEditing && (
              <span className={cn("flex shrink-0 items-center gap-1 text-xs", variant === "sidebar" ? "text-[#858a92]" : "text-chalk-text-muted")}>
                You
                {onUpdateDisplayName && (
                  <button type="button" onClick={() => setIsEditing(true)} className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 hover:text-primary">
                    <Edit02Icon className="w-3 h-3" />
                  </button>
                )}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            {participant.role && participant.role !== "participant" && (
              <span className={cn("text-[11px] font-normal tracking-normal", variant === "sidebar" ? "text-[#858a92]" : "rounded bg-chalk-bg-subtle px-1.5 py-0.5 text-chalk-text-secondary")}>{variant === "sidebar" ? (participant.role === "host" ? "Host" : "Co-host") : participant.role}</span>
            )}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-1 shrink-0">
        {variant === "sidebar" ? participant.isMuted ? <MicrophoneOff01Icon className="mr-1 h-4 w-4 text-[#b94c4c]" aria-label="Muted" /> : null : <AudioIndicator muted={participant.isMuted} level={participant.isMuted ? 0 : 0.5} className={cn(participant.isMuted && "text-chalk-error-main")} />}

        {showMenuButton && !isEditing && (
          <div className="relative">
            <IconButton icon={<MoreVerticalIcon className="w-4 h-4" />} size="sm" variant="ghost" className={optionsButtonClassName} onClick={onMenuToggle} aria-label={`Options for ${participant.displayName}`} />

            {menuOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={onMenuClose} />
                <div className={cn("absolute right-0 top-full z-20 mt-1 w-60 overflow-hidden rounded-[12px] p-1.5 shadow-[0_20px_50px_rgba(12,14,18,0.14)]", variant === "sidebar" ? "border border-[#c9c8c2] bg-[#fbfaf7]" : "border border-chalk-border-subtle bg-chalk-bg-surface")}>
                  <ParticipantOptionsMenu
                    participant={participant}
                    variant={variant}
                    canManageParticipants={canManageParticipants}
                    onClose={onMenuClose}
                    onMuteParticipant={onMuteParticipant}
                    onRequestUnmute={onRequestUnmute}
                    onStopParticipantCamera={onStopParticipantCamera}
                    onRequestStartCamera={onRequestStartCamera}
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
