import { Crown01Icon, Edit02Icon, Microphone01Icon, MicrophoneOff01Icon, Shield01Icon, UserRemove01Icon } from "../../../utils/icons";
import { cn } from "../../../utils/cn";
import { VolumeSlider } from "../../atomic";
import type { Participant, ParticipantListVariant } from "./ParticipantList";

export interface ParticipantOptionsMenuProps {
  participant: Participant;
  variant: ParticipantListVariant;
  canManageParticipants: boolean;
  onClose: () => void;
  onMuteParticipant?: (id: string) => void;
  onRemoveParticipant?: (id: string) => void;
  onMakeHost?: (id: string) => void;
  onMakeCoHost?: (id: string) => void;
  onEditName?: () => void;
  participantVolumes?: ReadonlyMap<string, number>;
  onParticipantVolumeChange?: (id: string, volume: number) => void;
}

export function ParticipantOptionsMenu({ participant, variant, canManageParticipants, onClose, onMuteParticipant, onRemoveParticipant, onMakeHost, onMakeCoHost, onEditName, participantVolumes, onParticipantVolumeChange }: ParticipantOptionsMenuProps) {
  const hasVolumeControl = !participant.isLocal && !!participantVolumes && !!onParticipantVolumeChange;
  const hasLocalActions = !!onEditName;
  const hasManageActions = canManageParticipants && (!!onMuteParticipant || !!onRemoveParticipant || (!!onMakeHost && participant.role !== "host") || (!!onMakeCoHost && participant.role === "participant"));

  const volume = participantVolumes?.get(participant.id) ?? 100;
  const volumeMuted = volume <= 0;

  const menuItemClassName = cn("flex w-full items-center gap-2 px-3 py-2 text-left text-sm", variant === "sidebar" ? "text-popover-foreground hover:bg-muted/50" : "text-chalk-text-primary hover:bg-chalk-bg-subtle");

  const dividerClassName = cn("my-1 h-px", variant === "sidebar" ? "bg-border/50" : "bg-chalk-border-subtle");

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
        <div className={cn("px-3 py-2", variant === "sidebar" ? "text-popover-foreground" : "text-chalk-text-primary")}>
          <div className="mb-2 flex items-center justify-between gap-3">
            <span className="text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">Volume</span>
            <button
              type="button"
              onClick={() => onParticipantVolumeChange?.(participant.id, 100)}
              className={cn("text-xs underline underline-offset-2", variant === "sidebar" ? "text-muted-foreground hover:text-foreground" : "text-chalk-text-muted hover:text-chalk-text-primary")}
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
          {onMuteParticipant ? (
            <button
              type="button"
              onClick={() => {
                onMuteParticipant(participant.id);
                onClose();
              }}
              className={menuItemClassName}
            >
              {participant.isMuted ? <Microphone01Icon className="h-4 w-4" /> : <MicrophoneOff01Icon className="h-4 w-4" />}
              {participant.isMuted ? "Unmute" : "Mute"}
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
              className={cn("flex w-full items-center gap-2 px-3 py-2 text-left text-sm", variant === "sidebar" ? "text-[#dc2626] hover:bg-[#dc2626]/10" : "text-chalk-error-main hover:bg-chalk-error-subtle")}
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
