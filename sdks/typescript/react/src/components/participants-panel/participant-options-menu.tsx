import type { KeyboardEvent, ReactNode } from "react";
import { Edit02Icon, Microphone01Icon, MicrophoneOff01Icon, UserRemove01Icon, Video01Icon, VideoOffIcon } from "../../utils/icons";
import { VolumeHighIcon, VolumeMute01Icon } from "../../utils/icons";
import type { ParticipantListParticipant, ParticipantListVariant } from "./ParticipantsPanel";
import { ChalkButton, ChalkDivider, ChalkIconButton, ChalkMenuItem, ChalkSlider } from "../chalk-ui";
import { useSkin } from "../skin-context";
import { ClassicParticipantOptionsMenu } from "./ClassicParticipantOptionsMenu";

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
  onEditName?: () => void;
  participantVolumes?: ReadonlyMap<string, number>;
  onParticipantVolumeChange?: (id: string, volume: number) => void;
}

function ChalkParticipantOptionsMenu({ participant, variant, canManageParticipants, onClose, onMuteParticipant, onRequestUnmute, onStopParticipantCamera, onRequestStartCamera, onRemoveParticipant, onEditName, participantVolumes, onParticipantVolumeChange }: ParticipantOptionsMenuProps) {
  const hasVolumeControl = !participant.isLocal && !!participantVolumes && !!onParticipantVolumeChange;
  const hasLocalActions = !!onEditName;
  const hasManageActions = canManageParticipants && (!!onMuteParticipant || !!onRequestUnmute || !!onStopParticipantCamera || !!onRequestStartCamera || !!onRemoveParticipant);

  const volume = participantVolumes?.get(participant.id) ?? 100;
  const volumeMuted = volume <= 0;

  return (
    <>
      {hasLocalActions ? (
        <MenuAction onSelect={() => onEditName?.()}>
          <Edit02Icon className="h-4 w-4" />
          Edit Name
        </MenuAction>
      ) : null}

      {hasLocalActions && (hasVolumeControl || hasManageActions) ? <ChalkDivider className="my-1 h-3" /> : null}

      {hasVolumeControl ? (
        <div className="px-3.5 py-2.5 text-[var(--chalk-app-text)]">
          <div className="mb-2 flex items-center justify-between gap-3">
            <span className="text-[var(--chalk-app-text-muted)] text-sm font-medium">Volume</span>
            <ChalkButton variant="ghost" type="button" onClick={() => onParticipantVolumeChange?.(participant.id, 100)} className="min-h-0 px-0 py-0 text-xs text-[var(--chalk-app-text-muted)] hover:text-[var(--chalk-app-text)]" aria-label={`Reset volume for ${participant.displayName}`}>
              Reset
            </ChalkButton>
          </div>
          <div className="flex items-center gap-2">
            <ChalkIconButton type="button" size={variant === "mobile" ? "md" : "sm"} onClick={() => onParticipantVolumeChange?.(participant.id, volumeMuted ? 100 : 0)} aria-label={volumeMuted ? "Unmute volume" : "Mute volume"}>
              {volumeMuted ? <VolumeMute01Icon size={variant === "mobile" ? 18 : 14} /> : <VolumeHighIcon size={variant === "mobile" ? 18 : 14} />}
            </ChalkIconButton>
            <ChalkSlider aria-label={`Volume for ${participant.displayName}`} value={volumeMuted ? 0 : volume} min={0} max={100} step={1} onChange={(event) => onParticipantVolumeChange?.(participant.id, Number(event.target.value))} tone="accent" wrapperClassName="h-6 flex-1" className="w-full" />
            <span className="min-w-[2rem] text-center text-xs text-[var(--chalk-muted-text)]">{Math.round(volumeMuted ? 0 : volume)}%</span>
          </div>
        </div>
      ) : null}

      {hasVolumeControl && hasManageActions ? <ChalkDivider className="my-1 h-3" /> : null}

      {hasManageActions ? (
        <>
          {!participant.isMuted && onMuteParticipant ? (
            <MenuAction
              onSelect={() => {
                onMuteParticipant(participant.id);
                onClose();
              }}
            >
              <MicrophoneOff01Icon className="h-4 w-4" />
              Mute
            </MenuAction>
          ) : null}

          {participant.isMuted && onRequestUnmute ? (
            <MenuAction
              onSelect={() => {
                onRequestUnmute(participant.id);
                onClose();
              }}
            >
              <Microphone01Icon className="h-4 w-4" />
              Ask to unmute
            </MenuAction>
          ) : null}

          {participant.isVideoEnabled && onStopParticipantCamera ? (
            <MenuAction
              onSelect={() => {
                onStopParticipantCamera(participant.id);
                onClose();
              }}
            >
              <VideoOffIcon className="h-4 w-4" />
              Stop camera
            </MenuAction>
          ) : null}

          {!participant.isVideoEnabled && onRequestStartCamera ? (
            <MenuAction
              onSelect={() => {
                onRequestStartCamera(participant.id);
                onClose();
              }}
            >
              <Video01Icon className="h-4 w-4" />
              Ask to start camera
            </MenuAction>
          ) : null}

          {onRemoveParticipant ? (
            <MenuAction
              tone="danger"
              onSelect={() => {
                onRemoveParticipant(participant.id);
                onClose();
              }}
            >
              <UserRemove01Icon className="h-4 w-4" />
              Remove
            </MenuAction>
          ) : null}
        </>
      ) : null}
    </>
  );
}

export function ParticipantOptionsMenu(props: ParticipantOptionsMenuProps) {
  const skin = useSkin();
  return skin === "classic" ? <ClassicParticipantOptionsMenu {...props} /> : <ChalkParticipantOptionsMenu {...props} />;
}

interface MenuActionProps {
  readonly children: ReactNode;
  readonly onSelect: () => void;
  readonly tone?: "neutral" | "danger";
}

function MenuAction({ children, onSelect, tone = "neutral" }: MenuActionProps): React.JSX.Element {
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onSelect();
  };

  return (
    <ChalkMenuItem onClick={onSelect} onKeyDown={handleKeyDown} tone={tone} className="flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm font-medium">
      {children}
    </ChalkMenuItem>
  );
}
