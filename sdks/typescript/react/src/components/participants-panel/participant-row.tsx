import type { ParticipantListParticipant, ParticipantListVariant } from "./ParticipantsPanel";
import type { ParticipantGradientPreference } from "../../utils/colorGenerator";
import { useState, useRef, useEffect } from "react";
import { Popover } from "@base-ui/react/popover";
import { MicrophoneOff01Icon, VideoOffIcon, Edit02Icon } from "../../utils/icons";
import { Avatar } from "../atomic";
import { cn } from "../../utils/cn";
import { ParticipantOptionsMenu } from "./participant-options-menu";

export function ParticipantRow({
  participant,
  variant,
  canManageParticipants,
  onAssignRole,
  onStopParticipantScreenShare,
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
  const rootRef = useRef<HTMLDivElement>(null);

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
    <div ref={rootRef} className="call-person-row group">
      <div className="flex items-center gap-2.5 min-w-0 flex-1">
        <div className="relative">
          <Avatar name={participant.displayName} src={participant.avatarUrl} size="sm" generated={generatedAvatars} className="!h-8 !w-8" gradientPreference={participantGradientPreference} />
        </div>

        <div className="flex flex-col min-w-0 flex-1">
          <div className="flex items-center gap-1.5 w-full">
            {isEditing ? (
              <div className="flex items-center gap-1 flex-1">
                <input
                  ref={inputRef}
                  type="text"
                  aria-label="Your name"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  onKeyDown={handleKeyDown}
                  onBlur={handleSave}
                  className="w-full min-w-0 rounded border border-[var(--chalk-app-control-active-line)]/30 bg-[var(--chalk-app-input)] px-1.5 py-0.5 text-sm font-normal text-[var(--chalk-app-text)] outline-none focus:border-[var(--chalk-app-control-active-line)]"
                />
              </div>
            ) : (
              <span className="min-w-0 truncate text-sm font-medium text-[var(--chalk-app-text)]" onClick={() => participant.isLocal && onUpdateDisplayName && setIsEditing(true)} title={participant.isLocal && onUpdateDisplayName ? "Click to edit" : undefined}>
                <bdi>{participant.displayName}</bdi>
              </span>
            )}
            {participant.role === "host" && !isEditing ? <span className="shrink-0 text-xs text-[var(--chalk-app-text-muted)]">Host</span> : null}
            {participant.isLocal && !isEditing && (
              <span className="flex shrink-0 items-center gap-1 text-xs text-[var(--chalk-app-text-muted)]">
                (You)
                {onUpdateDisplayName && (
                  <button type="button" onClick={() => setIsEditing(true)} aria-label="Edit your name" className="call-edit-name">
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
        {participant.isMuted ? <MicrophoneOff01Icon className="h-4 w-4 text-[var(--chalk-danger-text)]" aria-label="Microphone off" role="img" /> : null}

        {participant.isHandRaised ? (
          <span className="call-hand" role="img" aria-label={`Hand raised${participant.handOrder ? `, number ${participant.handOrder}` : ""}`}>
            ✋{participant.handOrder}
          </span>
        ) : null}
        {!participant.isVideoEnabled ? <VideoOffIcon className="h-4 w-4 text-[var(--chalk-app-text-muted)]" aria-label="Camera off" role="img" /> : null}
        {showMenuButton && !isEditing && (
          <Popover.Root
            open={menuOpen}
            onOpenChange={(open) => {
              if (open) onMenuToggle();
              else onMenuClose();
            }}
          >
            <Popover.Trigger className={cn("call-person-options", optionsButtonClassName)} aria-label={`Options for ${participant.displayName}`}>
              <svg className="size-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M5 12h.01M12 12h.01M19 12h.01" />
              </svg>
            </Popover.Trigger>
            <Popover.Portal container={rootRef.current?.closest<HTMLElement>("[data-chalk]") ?? undefined}>
              <Popover.Positioner side="bottom" align="end" sideOffset={6} collisionPadding={8} className="chalk-popover-positioner">
                <Popover.Popup aria-label={`Options for ${participant.displayName}`} className="chalk-menu w-60">
                  <ParticipantOptionsMenu
                    participant={participant}
                    variant={variant}
                    canManageParticipants={canManageParticipants}
                    onClose={onMenuClose}
                    onAssignRole={onAssignRole}
                    onStopParticipantScreenShare={onStopParticipantScreenShare}
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
                </Popover.Popup>
              </Popover.Positioner>
            </Popover.Portal>
          </Popover.Root>
        )}
      </div>
    </div>
  );
}

export interface ParticipantRowProps {
  participant: ParticipantListParticipant;
  variant: ParticipantListVariant;
  canManageParticipants: boolean;
  onAssignRole?: (id: string, role: string) => Promise<unknown>;
  onStopParticipantScreenShare?: (id: string) => Promise<unknown>;
  onMuteParticipant?: (id: string) => void;
  onRequestUnmute?: (id: string) => void | Promise<unknown>;
  onStopParticipantCamera?: (id: string) => void;
  onRequestStartCamera?: (id: string) => void | Promise<unknown>;
  onRemoveParticipant?: (id: string) => void;
  onUpdateDisplayName?: (name: string) => void;
  onCommandError?: (message: string | null) => void;
  participantVolumes?: ReadonlyMap<string, number>;
  onParticipantVolumeChange?: (id: string, volume: number) => void;
  participantGradientPreference?: ParticipantGradientPreference;
  generatedAvatars?: boolean;
  menuOpen: boolean;
  onMenuToggle: () => void;
  onMenuClose: () => void;
}
