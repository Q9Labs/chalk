import { useState, type ReactNode } from "react";
import { cn } from "../../utils/cn";
import { Crown01Icon, Edit02Icon, Microphone01Icon, MicrophoneOff01Icon, Monitor01Icon, UserRemove01Icon, Video01Icon, VideoOffIcon } from "../../utils/icons";
import { VolumeSlider } from "../atomic";
import { ChalkButton } from "../chalk-ui";
import { runParticipantAction, type ParticipantOptionsMenuProps } from "./participant-options-menu-contract";

const styles = `.chalk-sheet:has(.call-sheet-menu) {
  max-height: 100%;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.call-row-menu {
  width: 252px;
  padding: var(--space-1-5);
}
.call-menu-item {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
  height: 40px;
  padding: 0 var(--space-3);
  border-radius: var(--corner-lg);
  font-size: var(--type-body);
  font-weight: 500;
  text-align: start;
  color: var(--chalk-text);
}
.call-menu-item:hover {
  background: var(--chalk-hover);
}
.call-menu-item svg {
  width: 18px;
  height: 18px;
  flex: none;
  color: var(--chalk-muted-text);
}
.call-menu-item.is-danger,
.call-menu-item.is-danger svg {
  color: var(--chalk-danger-text);
}
.call-menu-sep {
  height: 1px;
  margin: var(--space-1-5) var(--space-3);
  background: var(--chalk-line-strong);
}
.call-menu-confirm {
  display: grid;
  gap: var(--space-1);
  padding: var(--space-3) var(--space-3) var(--space-2);
}
.call-menu-confirm b {
  font-size: var(--type-body-lg);
  font-weight: 600;
}
.call-menu-confirm p {
  font-size: var(--type-body-sm);
  line-height: 1.45;
  color: var(--chalk-muted-text);
}
.call-menu-confirm-actions {
  display: flex;
  gap: var(--space-2);
  margin-top: var(--space-3);
}
.call-menu-confirm-actions .chalk-pill-button {
  flex: 1;
}
.call-menu-confirm-actions .chalk-pill-button[data-chalk-tone="danger"] {
  background: var(--chalk-danger);
  color: var(--chalk-on-overlay);
}
.call-sheet-menu {
  display: grid;
}
.call-sheet-who {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-2) var(--space-3);
}
.call-sheet-who b {
  display: block;
  font-size: var(--type-body-lg);
  font-weight: 600;
}
.call-sheet-who span {
  font-size: var(--type-body-sm);
  color: var(--chalk-muted-text);
}

@media (max-width: 767px) {
 .call-sheet-menu .call-menu-item { height: 48px; font-size: var(--type-body-lg); }
 .call-sheet-menu .call-menu-item svg { width: 20px; height: 20px; }
 .call-sheet-menu .call-menu-confirm { padding-inline: var(--space-2); }
 .call-sheet-menu .call-menu-confirm-actions .chalk-pill-button { height: 48px; }
}
`;

export function ParticipantOptionsMenu({
  header,
  participant,
  variant,
  canManageParticipants,
  onClose,
  onAssignRole,
  onStopParticipantScreenShare,
  onMuteParticipant,
  onRequestUnmute,
  onStopParticipantCamera,
  onRequestStartCamera,
  onRemoveParticipant,
  onEditName,
  participantVolumes,
  onParticipantVolumeChange,
  onCommandError,
}: ParticipantOptionsMenuProps & { readonly header?: ReactNode }) {
  const hasVolumeControl = !participant.isLocal && !!participantVolumes && !!onParticipantVolumeChange;
  const hasLocalActions = !!onEditName;
  const hasManageActions = canManageParticipants && !participant.isLocal && (!!onMuteParticipant || !!onRequestUnmute || !!onStopParticipantCamera || !!onRequestStartCamera || !!onRemoveParticipant || !!onAssignRole || !!onStopParticipantScreenShare);

  const volume = participantVolumes?.get(participant.id) ?? 100;
  const volumeMuted = volume <= 0;

  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const menuItemClassName = "call-menu-item";
  const dividerClassName = "call-menu-sep";

  const wrap = (content: ReactNode) => (
    <div className={header ? "call-sheet-menu" : undefined}>
      <style>{styles}</style>
      {header}
      {content}
    </div>
  );

  if (confirmingRemove && onRemoveParticipant) {
    const firstName = participant.displayName.split(" ")[0] ?? participant.displayName;
    return wrap(
      <div className="call-menu-confirm">
        <b>
          Remove <bdi>{firstName}</bdi> from the call?
        </b>
        <p>
          <bdi>{firstName}</bdi> leaves right away. Everyone else stays in the call.
        </p>
        <div className="call-menu-confirm-actions">
          <ChalkButton onClick={() => setConfirmingRemove(false)}>Cancel</ChalkButton>
          <ChalkButton variant="solid" tone="danger" onClick={() => void runParticipantAction(() => onRemoveParticipant(participant.id), onClose, onCommandError)}>
            Remove
          </ChalkButton>
        </div>
      </div>,
    );
  }

  return wrap(
    <>
      {hasLocalActions ? (
        <button type="button" onClick={onEditName} className={menuItemClassName}>
          <Edit02Icon />
          Edit name
        </button>
      ) : null}

      {hasLocalActions && (hasVolumeControl || hasManageActions) ? <div className={dividerClassName} /> : null}

      {hasVolumeControl ? (
        <div className="px-3.5 py-2.5 text-[var(--chalk-app-text)]">
          <div className="mb-2 flex items-center justify-between gap-3">
            <span className="text-[var(--chalk-app-text-muted)] text-sm font-medium">Volume</span>
            <button type="button" onClick={() => onParticipantVolumeChange?.(participant.id, 100)} className="text-[var(--chalk-app-text-muted)] text-xs hover:text-[var(--chalk-app-text)]" aria-label={`Reset volume for ${participant.displayName}`}>
              Reset
            </button>
          </div>
          <VolumeSlider
            value={volume}
            muted={volumeMuted}
            onChange={(nextVolume) => onParticipantVolumeChange?.(participant.id, nextVolume)}
            onMuteToggle={() => onParticipantVolumeChange?.(participant.id, volumeMuted ? 100 : 0)}
            size={variant === "mobile" ? "md" : "sm"}
            className="w-48"
            showValue
          />
        </div>
      ) : null}

      {hasVolumeControl && hasManageActions ? <div className={dividerClassName} /> : null}

      {hasManageActions ? (
        <>
          {!participant.isMuted && onMuteParticipant ? (
            <button
              type="button"
              onClick={() => {
                void runParticipantAction(() => onMuteParticipant(participant.id), onClose, onCommandError);
              }}
              className={menuItemClassName}
            >
              <MicrophoneOff01Icon />
              Mute
            </button>
          ) : null}

          {participant.isMuted && onRequestUnmute ? (
            <button
              type="button"
              onClick={() => {
                void runParticipantAction(() => onRequestUnmute(participant.id), onClose, onCommandError);
              }}
              className={menuItemClassName}
            >
              <Microphone01Icon />
              Ask to unmute
            </button>
          ) : null}

          {participant.isVideoEnabled && onStopParticipantCamera ? (
            <button
              type="button"
              onClick={() => {
                void runParticipantAction(() => onStopParticipantCamera(participant.id), onClose, onCommandError);
              }}
              className={menuItemClassName}
            >
              <VideoOffIcon />
              Stop camera
            </button>
          ) : null}

          {!participant.isVideoEnabled && onRequestStartCamera ? (
            <button
              type="button"
              onClick={() => {
                void runParticipantAction(() => onRequestStartCamera(participant.id), onClose, onCommandError);
              }}
              className={menuItemClassName}
            >
              <Video01Icon />
              Ask to start camera
            </button>
          ) : null}

          {participant.isScreenSharing && onStopParticipantScreenShare ? (
            <button type="button" className={menuItemClassName} onClick={() => void runParticipantAction(() => onStopParticipantScreenShare(participant.id), onClose, onCommandError)}>
              <Monitor01Icon />
              Stop screen share
            </button>
          ) : null}
          {onAssignRole
            ? participant.eligibleRoles
                ?.filter((role) => role !== participant.role)
                .map((role) => (
                  <button type="button" key={role} className={menuItemClassName} onClick={() => void runParticipantAction(() => onAssignRole(participant.id, role), onClose, onCommandError)}>
                    <Crown01Icon />
                    <span>
                      Make <bdi>{role}</bdi>
                    </span>
                  </button>
                ))
            : null}
          {onRemoveParticipant ? (
            <>
              <div className={dividerClassName} />
              <button type="button" onClick={() => setConfirmingRemove(true)} className={cn(menuItemClassName, "is-danger")}>
                <UserRemove01Icon />
                Remove
              </button>
            </>
          ) : null}
        </>
      ) : null}
    </>,
  );
}

export { runParticipantAction, type ParticipantOptionsMenuProps } from "./participant-options-menu-contract";
