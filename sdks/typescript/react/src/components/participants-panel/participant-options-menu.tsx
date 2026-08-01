import { Crown01Icon, Edit02Icon, Microphone01Icon, MicrophoneOff01Icon, Shield01Icon, UserRemove01Icon, Video01Icon, VideoOffIcon } from "../../utils/icons";
import { cn } from "../../utils/cn";
import { VolumeSlider } from "../atomic";
import type { ParticipantListParticipant, ParticipantListVariant } from "./ParticipantsPanel";

export interface ParticipantOptionsMenuProps {
  participant: ParticipantListParticipant;
  variant: ParticipantListVariant;
  canManageParticipants: boolean;
  onClose: () => void;
  onMuteParticipant?: (id: string) => void;
  onRequestUnmute?: (id: string) => void;
  onStopParticipantCamera?: (id: string) => void;
  onRequestStartCamera?: (id: string) => void;
  onRemoveParticipant?: (id: string) => void;
  onMakeHost?: (id: string) => void;
  onMakeCoHost?: (id: string) => void;
  onEditName?: () => void;
  participantVolumes?: ReadonlyMap<string, number>;
  onParticipantVolumeChange?: (id: string, volume: number) => void;
}

export function ParticipantOptionsMenu({
  participant,
  variant,
  canManageParticipants,
  onClose,
  onMuteParticipant,
  onRequestUnmute,
  onStopParticipantCamera,
  onRequestStartCamera,
  onRemoveParticipant,
  onMakeHost,
  onMakeCoHost,
  onEditName,
  participantVolumes,
  onParticipantVolumeChange,
}: ParticipantOptionsMenuProps) {
  const hasVolumeControl = !participant.isLocal && !!participantVolumes && !!onParticipantVolumeChange;
  const hasLocalActions = !!onEditName;
  const hasManageActions = canManageParticipants && (!!onMuteParticipant || !!onRequestUnmute || !!onStopParticipantCamera || !!onRequestStartCamera || !!onRemoveParticipant || (!!onMakeHost && participant.role !== "host") || (!!onMakeCoHost && participant.role === "participant"));

  const volume = participantVolumes?.get(participant.id) ?? 100;
  const volumeMuted = volume <= 0;

  const menuItemClassName = cn("flex w-full items-center gap-3 rounded-[8px] px-3 py-2.5 text-left text-sm font-medium transition-colors", variant === "sidebar" ? "text-[#202329] hover:bg-white" : "text-chalk-text-primary hover:bg-chalk-bg-subtle");

  const dividerClassName = cn("my-1.5 h-px", variant === "sidebar" ? "bg-[#e5e4df]" : "bg-chalk-border-subtle");

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
        <div className={cn("px-3.5 py-2.5", variant === "sidebar" ? "text-[#202329]" : "text-chalk-text-primary")}>
          <div className="mb-2 flex items-center justify-between gap-3">
            <span className="text-sm font-medium text-[#555b65]">Volume</span>
            <button
              type="button"
              onClick={() => onParticipantVolumeChange?.(participant.id, 100)}
              className={cn("text-xs", variant === "sidebar" ? "text-[#858a92] hover:text-[#202329]" : "text-chalk-text-muted hover:text-chalk-text-primary")}
              aria-label={`Reset volume for ${participant.displayName}`}
            >
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
                onMuteParticipant(participant.id);
                onClose();
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
                onRequestUnmute(participant.id);
                onClose();
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
                onStopParticipantCamera(participant.id);
                onClose();
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
                onRequestStartCamera(participant.id);
                onClose();
              }}
              className={menuItemClassName}
            >
              <Video01Icon className="h-4 w-4" />
              Ask to start camera
            </button>
          ) : null}

          {onMakeHost && participant.role !== "host" ? (
            <button
              type="button"
              onClick={() => {
                onMakeHost(participant.id);
                onClose();
              }}
              className={menuItemClassName}
            >
              <Crown01Icon className="h-4 w-4" />
              Make Host
            </button>
          ) : null}

          {onMakeCoHost && participant.role === "participant" ? (
            <button
              type="button"
              onClick={() => {
                onMakeCoHost(participant.id);
                onClose();
              }}
              className={menuItemClassName}
            >
              <Shield01Icon className="h-4 w-4" />
              Make Co-Host
            </button>
          ) : null}

          {onRemoveParticipant ? (
            <button
              type="button"
              onClick={() => {
                onRemoveParticipant(participant.id);
                onClose();
              }}
              className={cn("flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left text-sm transition-colors", variant === "sidebar" ? "text-[#b94c4c] hover:bg-[#fdf0f0]" : "text-chalk-error-main hover:bg-chalk-error-subtle")}
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
