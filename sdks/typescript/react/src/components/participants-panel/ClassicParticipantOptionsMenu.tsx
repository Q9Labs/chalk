import { Edit02Icon, Microphone01Icon, MicrophoneOff01Icon, UserRemove01Icon, Video01Icon, VideoOffIcon } from "../../utils/icons";
import { cn } from "../../utils/cn";
import { VolumeSlider } from "../atomic";
import { runParticipantAction, type ParticipantOptionsMenuProps } from "./participant-options-menu-contract";

export function ClassicParticipantOptionsMenu({
  participant,
  variant,
  canManageParticipants,
  onClose,
  onMuteParticipant,
  onRequestUnmute,
  onStopParticipantCamera,
  onRequestStartCamera,
  onRemoveParticipant,
  onEditName,
  participantVolumes,
  onParticipantVolumeChange,
  onCommandError,
}: ParticipantOptionsMenuProps) {
  const hasVolumeControl = !participant.isLocal && !!participantVolumes && !!onParticipantVolumeChange;
  const hasLocalActions = !!onEditName;
  const hasManageActions = canManageParticipants && (!!onMuteParticipant || !!onRequestUnmute || !!onStopParticipantCamera || !!onRequestStartCamera || !!onRemoveParticipant);

  const volume = participantVolumes?.get(participant.id) ?? 100;
  const volumeMuted = volume <= 0;

  const menuItemClassName = cn("flex w-full items-center gap-3 rounded-[8px] px-3 py-2.5 text-left text-sm font-medium text-[var(--chalk-app-text)] transition-colors hover:bg-[var(--chalk-app-control-hover)]");

  const dividerClassName = "my-1.5 h-px bg-[var(--chalk-app-line)]";

  return (
    <>
      {hasLocalActions ? (
        <button type="button" onClick={onEditName} className={menuItemClassName}>
          <Edit02Icon className="h-4 w-4" />
          Edit Name
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
              <MicrophoneOff01Icon className="h-4 w-4" />
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
              <Microphone01Icon className="h-4 w-4" />
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
              <VideoOffIcon className="h-4 w-4" />
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
              <Video01Icon className="h-4 w-4" />
              Ask to start camera
            </button>
          ) : null}

          {onRemoveParticipant ? (
            <button
              type="button"
              onClick={() => {
                void runParticipantAction(() => onRemoveParticipant(participant.id), onClose, onCommandError);
              }}
              className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left text-sm text-[var(--chalk-app-danger)] transition-colors hover:bg-[var(--chalk-app-danger)]/10"
            >
              <UserRemove01Icon className="h-4 w-4" />
              Remove
            </button>
          ) : null}
        </>
      ) : null}
    </>
  );
}
