import { useState, useRef, useEffect } from "react";
import { IconButton } from "@q9labsai/chalk-ui";
import { MoreVerticalIcon, MicrophoneOff01Icon, Edit02Icon } from "../../utils/icons";
import { Avatar, AudioIndicator, HandRaiseIndicator } from "../atomic";
import { cn } from "../../utils/cn";
import { ParticipantOptionsMenu } from "./participant-options-menu";
import type { ParticipantRowProps } from "./participant-row";

export function ClassicParticipantRow({
  participant,
  variant,
  canManageParticipants,
  onMuteParticipant,
  onRequestUnmute,
  onStopParticipantCamera,
  onRequestStartCamera,
  onRemoveParticipant,
  onUpdateDisplayName,
  onCommandError,
  participantVolumes,
  onParticipantVolumeChange,
  participantGradientPreference,
  generatedAvatars = true,
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

  const optionsButtonClassName =
    variant === "mobile" ? "text-[var(--chalk-app-text-muted)] hover:text-[var(--chalk-app-text)]" : variant === "sidebar" ? "opacity-70 text-[var(--chalk-app-text-muted)] hover:text-[var(--chalk-app-text)] hover:opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100";

  return (
    <div className={cn("group relative flex items-center justify-between rounded-lg p-3 transition-colors hover:bg-[var(--chalk-app-control-hover)]", variant === "sidebar" && "rounded-none px-1 py-3.5 hover:bg-[var(--chalk-app-control-hover)]")}>
      <div className="flex items-center gap-3 min-w-0 flex-1">
        <div className="relative">
          <Avatar name={participant.displayName} src={participant.avatarUrl} size="sm" generated={generatedAvatars} className={cn(variant === "sidebar" && "h-10 w-10")} gradientPreference={participantGradientPreference} />
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
                  className="w-full min-w-0 rounded border border-[var(--chalk-app-control-active-line)]/30 bg-[var(--chalk-app-input)] px-1.5 py-0.5 text-sm font-normal text-[var(--chalk-app-text)] outline-none focus:border-[var(--chalk-app-control-active-line)]"
                />
              </div>
            ) : (
              <span className="max-w-[140px] truncate text-sm font-semibold text-[var(--chalk-app-text)]" onClick={() => participant.isLocal && onUpdateDisplayName && setIsEditing(true)} title={participant.isLocal && onUpdateDisplayName ? "Click to edit" : undefined}>
                {participant.displayName}
              </span>
            )}
            {participant.isLocal && !isEditing && (
              <span className="flex shrink-0 items-center gap-1 text-xs text-[var(--chalk-app-text-muted)]">
                You
                {onUpdateDisplayName && (
                  <button type="button" onClick={() => setIsEditing(true)} className="p-0.5 opacity-0 transition-opacity hover:text-[var(--chalk-app-text)] group-hover:opacity-100">
                    <Edit02Icon className="w-3 h-3" />
                  </button>
                )}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5"></div>
        </div>
      </div>

      <div className="flex items-center gap-1 shrink-0">
        {variant === "sidebar" ? (
          participant.isMuted ? (
            <MicrophoneOff01Icon className="mr-1 h-4 w-4 text-[var(--chalk-app-danger)]" aria-label="Muted" />
          ) : null
        ) : (
          <AudioIndicator muted={participant.isMuted} level={participant.isMuted ? 0 : 0.5} className={cn(participant.isMuted && "text-[var(--chalk-app-danger)]")} />
        )}

        {showMenuButton && !isEditing && (
          <div className="relative">
            <IconButton icon={<MoreVerticalIcon className="w-4 h-4" />} size="sm" variant="ghost" className={optionsButtonClassName} onClick={onMenuToggle} aria-label={`Options for ${participant.displayName}`} />

            {menuOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={onMenuClose} />
                <div className="chalk-textured-surface absolute right-0 top-full z-20 mt-1 w-60 overflow-hidden rounded-[12px] border border-[var(--chalk-app-line-strong)] bg-[var(--chalk-app-panel)] p-1.5 text-[var(--chalk-app-text)] shadow-[var(--chalk-app-shadow-sm)]">
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
                    onCommandError={onCommandError}
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
