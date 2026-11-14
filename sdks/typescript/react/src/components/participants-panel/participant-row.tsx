import type { ParticipantListParticipant, ParticipantListVariant } from "./ParticipantsPanel";
import type { ParticipantGradientPreference } from "../../utils/colorGenerator";
import { Suspense, useState, useRef, useEffect, type ReactNode } from "react";
import { ChalkPopoverPrimitive as Popover, ChalkSheet } from "../chalk-ui";
import { Crown01Icon } from "../../utils/icons";
import { MediaGlyph, ShellIcon } from "../control-bar/ShellIcon";
import { preloadable } from "../../internal/preloadable";
import { Avatar } from "../atomic";
import { useNarrowCall } from "../../internal/call-width";
import { useIsMobile } from "../../internal/useMediaQuery";
import { splitMatch } from "./participant-search";

// The menu downloads on intent (hover, focus or press of its button), so "Edit name" and the rest open with their content on the first frame without growing the panel's first load.
const { Component: ParticipantOptionsMenu, preload: preloadOptionsMenu } = preloadable(() => import("./participant-options-menu").then((module) => module.ParticipantOptionsMenu));

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
  onParticipantClick,
  participantGradientPreference,
  generatedAvatars = true,
  menuOpen,
  onMenuToggle,
  onMenuClose,
  query = "",
  handNumber,
}: ParticipantRowProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState(participant.displayName);
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const hasVolumeControl = !!participantVolumes && !!onParticipantVolumeChange;
  const showMenuButton = canManageParticipants || hasVolumeControl || (participant.isLocal && !!onUpdateDisplayName);

  // ast-grep-ignore: chalk.forbid-sdk-use-effect-tsx -- [dom] Focus and select the mounted participant-name input when editing starts.
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

  const narrowCall = useNarrowCall();
  const narrowWindow = useIsMobile();
  const phone = narrowCall || narrowWindow;
  const [before, match, after] = splitMatch(participant.displayName, query);
  const subLine = participant.isReconnecting ? "Reconnecting…" : participant.isScreenSharing ? "Sharing screen" : participant.deviceHint;
  const menu = (header?: ReactNode) => (
    <Suspense fallback={null}>
      <ParticipantOptionsMenu
        header={header}
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
    </Suspense>
  );
  const optionsLabel = `Options for ${participant.displayName}`;

  return (
    <div
      ref={rootRef}
      className="call-person-row"
      data-reconnecting={participant.isReconnecting || undefined}
      data-open={menuOpen || undefined}
      onClick={(event) => {
        if (event.target instanceof Element && event.currentTarget.contains(event.target) && !event.target.closest("button, input, [role=menu]")) onParticipantClick?.(participant.id);
      }}
    >
      <span className="call-person-avatar" data-speaking={participant.isSpeaking || undefined}>
        <Avatar name={participant.displayName} src={participant.avatarUrl} size="sm" generated={generatedAvatars} className="!h-8 !w-8" gradientPreference={participantGradientPreference} />
      </span>

      <div className="call-person-who">
        <div className="call-person-name-line">
          {isEditing ? (
            <input ref={inputRef} type="text" aria-label="Your name" value={editName} onChange={(e) => setEditName(e.target.value)} onKeyDown={handleKeyDown} onBlur={handleSave} className="call-person-name-input" />
          ) : (
            <button
              type="button"
              className="call-person-name"
              onClick={() => {
                if (onParticipantClick) onParticipantClick(participant.id);
                else if (participant.isLocal && onUpdateDisplayName) setIsEditing(true);
              }}
              aria-label={onParticipantClick ? `Show ${participant.displayName} on main screen` : participant.displayName}
            >
              <bdi>
                {before}
                {match ? <mark>{match}</mark> : null}
                {after}
              </bdi>
            </button>
          )}
          {participant.isLocal && !isEditing ? <span className="call-person-you">(You)</span> : null}
          {participant.isHost && !isEditing ? (
            <span className="call-person-host" role="img" aria-label="Host" title="Host">
              <Crown01Icon aria-hidden="true" />
            </span>
          ) : null}
        </div>
        {subLine ? <div className="call-person-sub">{subLine}</div> : null}
      </div>

      <div className="call-person-state-slots">
        {participant.isHandRaised ? (
          <span className="call-hand" data-solo={handNumber === undefined || undefined} role="img" aria-label={`Hand raised${handNumber ? `, number ${handNumber}` : ""}`}>
            <ShellIcon name="hand" size={14} />
            {handNumber}
          </span>
        ) : null}
        {participant.isSpeaking && !participant.isMuted ? (
          <span className="call-person-state" role="img" aria-label="Speaking">
            <span className="call-eq" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
          </span>
        ) : (
          <span className="call-person-state" data-off={participant.isMuted || undefined} role="img" aria-label={participant.isMuted ? "Microphone off" : "Microphone on"}>
            <MediaGlyph kind="mic" slashed={participant.isMuted === true} busy={false} />
          </span>
        )}
        <span className="call-person-state" role="img" aria-label={participant.isVideoEnabled ? "Camera on" : "Camera off"}>
          <MediaGlyph kind="cam" slashed={participant.isVideoEnabled !== true} busy={false} />
        </span>
      </div>

      {showMenuButton && !isEditing ? (
        phone ? (
          <>
            <button onPointerEnter={() => void preloadOptionsMenu()} onPointerDown={() => void preloadOptionsMenu()} onFocus={() => void preloadOptionsMenu()} type="button" className="call-person-options" aria-label={optionsLabel} aria-expanded={menuOpen} onClick={onMenuToggle}>
              <MoreIcon />
            </button>
            <ChalkSheet open={menuOpen} onOpenChange={(open) => (open ? onMenuToggle() : onMenuClose())} title={optionsLabel}>
              {menu(
                <div className="call-sheet-who">
                  <Avatar name={participant.displayName} src={participant.avatarUrl} size="md" generated={generatedAvatars} gradientPreference={participantGradientPreference} />
                  <div>
                    <b>
                      <bdi>{participant.displayName}</bdi>
                    </b>
                    <span>{participant.isHandRaised ? `Hand raised${handNumber ? `, number ${handNumber}` : ""}` : participant.isLocal ? "You" : participant.isHost ? "Host" : "Guest"}</span>
                  </div>
                </div>,
              )}
            </ChalkSheet>
          </>
        ) : (
          <Popover.Root
            open={menuOpen}
            onOpenChange={(open) => {
              if (open) onMenuToggle();
              else onMenuClose();
            }}
          >
            <Popover.Trigger onPointerEnter={() => void preloadOptionsMenu()} onPointerDown={() => void preloadOptionsMenu()} onFocus={() => void preloadOptionsMenu()} className="call-person-options" aria-label={optionsLabel}>
              <MoreIcon />
            </Popover.Trigger>
            <Popover.Portal container={rootRef.current?.closest<HTMLElement>("[data-chalk]") ?? undefined}>
              <Popover.Positioner side="bottom" align="end" sideOffset={6} collisionPadding={8} className="chalk-popover-positioner">
                <Popover.Popup aria-label={optionsLabel} className="chalk-menu call-row-menu">
                  {menu()}
                </Popover.Popup>
              </Popover.Positioner>
            </Popover.Portal>
          </Popover.Root>
        )
      ) : (
        <span className="call-person-options-slot" />
      )}
    </div>
  );
}

function MoreIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12h.01M12 12h.01M19 12h.01" />
    </svg>
  );
}

export interface ParticipantRowProps {
  onParticipantClick?: (id: string) => void;
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
  /** Search text to highlight in the name. */
  query?: string;
  /** The hand's place in the queue, set only while two or more hands are up. */
  handNumber?: number;
  menuOpen: boolean;
  onMenuToggle: () => void;
  onMenuClose: () => void;
}
