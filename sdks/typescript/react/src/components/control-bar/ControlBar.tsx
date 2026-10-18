import { ChalkIconButton, ChalkTooltip } from "../chalk-ui";
import React from "react";
import { Tooltip } from "@q9labsai/chalk-ui";
import { cn } from "../../utils/cn";
import { CallEnd01Icon, CircleIcon, Edit02Icon, HandIcon, Message01Icon, Microphone01Icon, MicrophoneOff01Icon, Monitor01Icon, MonitorOffIcon, SmileIcon, ThumbsUpIcon, UserGroupIcon, Video01Icon, VideoOffIcon } from "../../utils/icons";
import { ControlBarButton } from "../atomic";
import { DevicePopover } from "../device-popover/DevicePopover";
import { CommandErrorAlert } from "../composite/CommandErrorAlert";
import { LeaveMenu } from "./LeaveMenu";
import { useConnectedControlBarBehavior, useControlBarSurfaceBehavior, type ControlBarButtonName, type ControlBarProps, type ControlBarSurfaceProps } from "./control-bar-behavior";

export type { ControlBarProps, ControlBarButtonName } from "./control-bar-behavior";

export function ControlBarPresentation(props: ControlBarSurfaceProps): React.JSX.Element {
  const surfaceProps: ControlBarSurfaceProps = props.displayOnly ? { ...props, detectDevices: false } : props;
  return <ControlBarSurface {...surfaceProps} />;
}

const FloatingControlBarButton = React.forwardRef<
  HTMLButtonElement,
  {
    readonly icon: React.ReactNode;
    readonly label: string;
    readonly active?: boolean;
    readonly danger?: boolean;
    readonly badge?: number;
  } & Omit<React.ComponentPropsWithoutRef<"button">, "children" | "aria-label">
>(function FloatingControlBarButton({ icon, label, active = false, danger = false, badge, ...buttonProps }, ref) {
  return (
    <ChalkTooltip
      trigger={
        <ChalkIconButton {...buttonProps} size="lg" tone={danger ? "danger" : "neutral"} ref={ref} type="button" aria-label={label} aria-pressed={active}>
          {icon}
          {badge && badge > 0 ? <span className="absolute top-1.5 right-1.5 grid min-h-[17px] min-w-[17px] place-items-center rounded-full bg-[var(--chalk-app-danger)] px-1 text-[10px] !text-white">{badge > 99 ? "99+" : badge}</span> : null}
        </ChalkIconButton>
      }
    >
      {label}
    </ChalkTooltip>
  );
});

export const ControlBarSurface = React.memo(
  ({
    isMuted = false,
    microphonePending = false,
    cameraPending = false,
    isVideoEnabled = true,
    isScreenSharing = false,
    isRecording = false,
    isRecordingPending = false,
    isChatOpen = false,
    isParticipantsOpen = false,
    isHandRaised = false,
    isWhiteboardOpen = false,
    unreadChatCount = 0,
    audioInputDevices,
    audioOutputDevices,
    videoInputDevices,
    selectedAudioInput,
    selectedAudioOutput,
    selectedVideoInput,
    density = "comfortable",
    buttons,

    onToggleMute,
    onToggleVideo,
    onAudioInputChange,
    onAudioOutputChange,
    onVideoInputChange,
    onToggleScreenShare,
    onToggleRecording,
    onToggleChat,
    onToggleParticipants,
    onToggleHandRaise,
    onToggleWhiteboard,
    onOpenReactions,
    onLeft,
    onEndForEveryone,
    participantColorSeed,
    participantGradientPreference,
    expanded = true,
    detectDevices = true,
    displayOnly = false,

    className,
  }: ControlBarSurfaceProps) => {
    const { themeVariables, buttonsToRender, effectiveAudioInputDevices, effectiveAudioOutputDevices, effectiveVideoInputDevices, showLeave } = useControlBarSurfaceBehavior({
      density,
      buttons,
      audioInputDevices,
      audioOutputDevices,
      videoInputDevices,
      selectedAudioInput,
      selectedAudioOutput,
      selectedVideoInput,
      participantColorSeed,
      participantGradientPreference,
      detectDevices,
    });

    const screenShareButton = (
      <ControlBarButton
        key="screenshare"
        icon={isScreenSharing ? <MonitorOffIcon /> : <Monitor01Icon />}
        label={isScreenSharing ? "Stop Share" : "Share Screen"}
        onClick={onToggleScreenShare}
        active={isScreenSharing}
        activeClassName="bg-[var(--chalk-app-control-active)] text-[var(--chalk-app-control-active-text)] ring-2 ring-[var(--chalk-app-control-active-line)] ring-offset-2 ring-offset-[var(--chalk-app-canvas)] hover:bg-[var(--chalk-app-control-hover)]"
        data-tour="controls-screenshare"
      />
    );

    // Compact floating layout matching the screenshot
    if (density === "compact") {
      return (
        <div
          className={cn("flex w-full flex-wrap items-center gap-2 bg-transparent px-2 py-3 sm:px-4", className)}
          style={{
            ...(themeVariables as React.CSSProperties),
            paddingBottom: "max(12px, env(safe-area-inset-bottom))",
          }}
          role="toolbar"
          aria-label="Space controls"
        >
          <div className="flex flex-wrap items-center justify-center gap-1.5 mx-auto">
            {/* Group 1: Media Controls */}
            <div className="order-1 flex shrink-0 items-center gap-1 rounded-[8px] border border-[var(--chalk-app-control-primary)] bg-[var(--chalk-app-control-primary)] p-1 shadow-[var(--chalk-app-shadow-control)]">
              <button
                type="button"
                onClick={onToggleMute}
                className={cn("flex h-[44px] w-[44px] items-center justify-center rounded-[6px] transition active:scale-95 sm:h-[46px] sm:w-[46px]", !isMuted ? "!text-white" : "!text-[var(--chalk-app-danger)]")}
                aria-label={isMuted ? "Unmute" : "Mute"}
                aria-pressed={!isMuted}
              >
                {isMuted ? <MicrophoneOff01Icon className="w-5 h-5" /> : <Microphone01Icon className="w-5 h-5" />}
              </button>

              <button
                type="button"
                onClick={onToggleVideo}
                className={cn("flex h-[44px] w-[44px] items-center justify-center rounded-[6px] transition active:scale-95 sm:h-[46px] sm:w-[46px]", isVideoEnabled ? "!text-white" : "!text-[var(--chalk-app-danger)]")}
                aria-label={isVideoEnabled ? "Stop Video" : "Start Video"}
                aria-pressed={isVideoEnabled}
              >
                {isVideoEnabled ? <Video01Icon className="w-5 h-5" /> : <VideoOffIcon className="w-5 h-5" />}
              </button>
            </div>

            {/* Group 2: Interactions */}
            <div className="order-3 flex shrink-0 items-center gap-1 rounded-[8px] border border-[var(--chalk-app-line)] bg-[var(--chalk-app-control)] p-1 shadow-[var(--chalk-app-shadow-control)]">
              {buttonsToRender.includes("screenshare") ? screenShareButton : null}
              {buttonsToRender.includes("handraise") && onToggleHandRaise && (
                <Tooltip content={isHandRaised ? "Lower hand" : "Raise hand"} position="top">
                  <button
                    type="button"
                    onClick={onToggleHandRaise}
                    className={cn(
                      "flex h-[44px] w-[44px] items-center justify-center rounded-[6px] text-[var(--chalk-app-text)] transition active:scale-95 sm:h-[46px] sm:w-[46px]",
                      isHandRaised ? "bg-[var(--chalk-app-control-active)] ring-2 ring-[var(--chalk-app-control-active-line)] ring-inset" : "",
                    )}
                    aria-label={isHandRaised ? "Lower hand" : "Raise hand"}
                    aria-pressed={isHandRaised}
                  >
                    <HandIcon className="w-5 h-5" />
                  </button>
                </Tooltip>
              )}
              {buttonsToRender.includes("reactions") && onOpenReactions && (
                <Tooltip content="Reactions" position="top">
                  <button type="button" onClick={onOpenReactions} className="flex h-[44px] w-[44px] items-center justify-center rounded-[6px] text-[var(--chalk-app-control-active-text)] transition active:scale-95 sm:h-[46px] sm:w-[46px]" aria-label="Reactions">
                    <ThumbsUpIcon className="w-5 h-5" />
                  </button>
                </Tooltip>
              )}
              {buttonsToRender.includes("whiteboard") && onToggleWhiteboard && (
                <Tooltip content="Board" position="top">
                  <button
                    type="button"
                    onClick={onToggleWhiteboard}
                    className={cn(
                      "flex h-[44px] w-[44px] items-center justify-center rounded-[6px] text-[var(--chalk-app-text)] transition active:scale-95 sm:h-[46px] sm:w-[46px]",
                      isWhiteboardOpen ? "bg-[var(--chalk-app-control-active)] ring-2 ring-[var(--chalk-app-control-active-line)] ring-inset" : "",
                    )}
                    aria-label="Whiteboard"
                    aria-pressed={isWhiteboardOpen}
                  >
                    <Edit02Icon className="w-5 h-5" />
                  </button>
                </Tooltip>
              )}
              {buttonsToRender.includes("participants") && onToggleParticipants && (
                <Tooltip content="Participants" position="top">
                  <button
                    type="button"
                    onClick={onToggleParticipants}
                    className={cn(
                      "flex h-[44px] w-[44px] items-center justify-center rounded-[6px] text-[var(--chalk-app-text)] transition active:scale-95 sm:h-[46px] sm:w-[46px]",
                      isParticipantsOpen ? "bg-[var(--chalk-app-control-active)] ring-2 ring-[var(--chalk-app-control-active-line)] ring-inset" : "",
                    )}
                    aria-label="Participants"
                    aria-pressed={isParticipantsOpen}
                  >
                    <UserGroupIcon className="w-5 h-5" />
                  </button>
                </Tooltip>
              )}
              {buttonsToRender.includes("chat") && onToggleChat && (
                <Tooltip content="Chat" position="top">
                  <button
                    type="button"
                    onClick={onToggleChat}
                    className={cn(
                      "relative flex h-[44px] w-[44px] items-center justify-center rounded-[6px] text-[var(--chalk-app-text)] transition active:scale-95 sm:h-[46px] sm:w-[46px]",
                      isChatOpen ? "bg-[var(--chalk-app-control-active)] ring-2 ring-[var(--chalk-app-control-active-line)] ring-inset" : "",
                    )}
                    aria-label="Chat"
                    aria-pressed={isChatOpen}
                  >
                    <Message01Icon className="w-5 h-5" />
                    {unreadChatCount > 0 && !isChatOpen ? (
                      <span className="absolute -top-1 -right-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-[var(--chalk-app-danger)] px-1 text-[10px] font-semibold text-white">{unreadChatCount > 99 ? "99+" : unreadChatCount}</span>
                    ) : null}
                  </button>
                </Tooltip>
              )}
            </div>

            {/* Group 3: Leave */}
            <div className="order-2 flex shrink-0 items-center gap-1 rounded-[8px] border border-[var(--chalk-app-line)] bg-[var(--chalk-app-control)] p-1 shadow-[var(--chalk-app-shadow-control)]">
              <LeaveMenu
                onLeave={onLeft}
                onEndForEveryone={onEndForEveryone}
                renderButton={(buttonProps) => (
                  <Tooltip content="Leave call" position="top">
                    <button
                      {...buttonProps}
                      type="button"
                      className="flex h-[44px] w-[44px] items-center justify-center rounded-[6px] border border-[var(--chalk-app-danger)] bg-[var(--chalk-app-danger)] p-0 text-white transition active:scale-95 hover:bg-[var(--chalk-app-danger-hover)] sm:h-[46px] sm:w-[46px]"
                      aria-label="Leave call"
                    >
                      <CallEnd01Icon className="w-5 h-5" />
                    </button>
                  </Tooltip>
                )}
              />
            </div>
          </div>
        </div>
      );
    }

    {
      const floatingButton = (type: ControlBarButtonName): React.ReactNode => {
        switch (type) {
          case "mic":
            return <FloatingControlBarButton key={type} icon={isMuted ? <MicrophoneOff01Icon /> : <Microphone01Icon />} label={isMuted ? "Unmute" : "Mute"} onClick={onToggleMute} active={!isMuted} />;
          case "video":
            return <FloatingControlBarButton key={type} icon={isVideoEnabled ? <Video01Icon /> : <VideoOffIcon />} label="Camera" onClick={onToggleVideo} active={isVideoEnabled} />;
          case "screenshare":
            return <FloatingControlBarButton key={type} icon={isScreenSharing ? <MonitorOffIcon /> : <Monitor01Icon />} label={isScreenSharing ? "Stop share" : "Share"} onClick={onToggleScreenShare} active={isScreenSharing} />;
          case "whiteboard":
            if (!onToggleWhiteboard && !displayOnly) return null;
            return <FloatingControlBarButton key={type} icon={<Edit02Icon />} label="Board" onClick={onToggleWhiteboard} active={isWhiteboardOpen} />;
          case "handraise":
            if (!onToggleHandRaise) return null;
            return <FloatingControlBarButton key={type} icon={<HandIcon />} label={isHandRaised ? "Lower" : "Raise"} onClick={onToggleHandRaise} active={isHandRaised} />;
          case "participants":
            if (!onToggleParticipants && !displayOnly) return null;
            return <FloatingControlBarButton key={type} icon={<UserGroupIcon />} label="Participants" onClick={onToggleParticipants} active={isParticipantsOpen} />;
          case "chat":
            if (!onToggleChat && !displayOnly) return null;
            return <FloatingControlBarButton key={type} icon={<Message01Icon />} label="Chat" onClick={onToggleChat} active={isChatOpen} badge={!isChatOpen ? unreadChatCount : 0} />;
          case "reactions":
            if (!onOpenReactions && !displayOnly) return null;
            return <FloatingControlBarButton key={type} icon={<SmileIcon />} label="React" onClick={onOpenReactions} />;

          case "record":
            if (!onToggleRecording && !displayOnly) return null;
            return (
              <FloatingControlBarButton
                key={type}
                icon={<CircleIcon className={isRecording ? "fill-current" : ""} />}
                label={isRecordingPending ? (isRecording ? "Stopping…" : "Starting…") : isRecording ? "Stop" : "Record"}
                onClick={onToggleRecording}
                active={isRecording}
                disabled={isRecordingPending}
              />
            );

          default:
            return null;
        }
      };

      return (
        <div className="pointer-events-none flex w-full items-end justify-center">
          <div className={cn("group pointer-events-auto flex max-w-full items-center justify-center gap-2 overflow-visible", className)} style={themeVariables as React.CSSProperties} data-part="dock" role="toolbar" aria-label="Space controls">
            {buttonsToRender.includes("mic") ? (
              <DevicePopover
                type="mic"
                busy={microphonePending}
                appearance="floating"
                isActive={!isMuted}
                onToggle={onToggleMute ?? (() => {})}
                devices={effectiveAudioInputDevices}
                selectedDeviceId={selectedAudioInput}
                onDeviceChange={onAudioInputChange ?? (() => {})}
                secondaryDevices={effectiveAudioOutputDevices}
                selectedSecondaryDeviceId={selectedAudioOutput}
                onSecondaryDeviceChange={onAudioOutputChange}
                orientation="up"
                haptic="medium"
              />
            ) : null}
            {buttonsToRender.includes("video") ? (
              <DevicePopover
                type="video"
                busy={cameraPending}
                appearance="floating"
                isActive={isVideoEnabled}
                onToggle={onToggleVideo ?? (() => {})}
                devices={effectiveVideoInputDevices}
                selectedDeviceId={selectedVideoInput}
                onDeviceChange={onVideoInputChange ?? (() => {})}
                orientation="up"
                haptic="medium"
              />
            ) : null}
            <div
              className={cn(
                "pointer-events-none grid min-w-0 transition-[grid-template-columns,margin,opacity,transform] duration-[260ms] ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[grid-template-columns,opacity,transform] motion-reduce:transition-none",
                expanded
                  ? "pointer-events-auto ml-0 grid-cols-[1fr] translate-x-0 opacity-100"
                  : "-ml-2 grid-cols-[0fr] -translate-x-1.5 opacity-0 group-hover:pointer-events-auto group-hover:ml-0 group-hover:grid-cols-[1fr] group-hover:translate-x-0 group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:ml-0 group-focus-within:grid-cols-[1fr] group-focus-within:translate-x-0 group-focus-within:opacity-100",
              )}
            >
              <div className="-my-2 flex min-w-0 flex-wrap items-center justify-center gap-2 py-2">{buttonsToRender.filter((button) => button !== "mic" && button !== "video" && button !== "leave").map(floatingButton)}</div>
            </div>
            {showLeave ? <LeaveMenu onLeave={onLeft} onEndForEveryone={onEndForEveryone} renderButton={(buttonProps) => <FloatingControlBarButton {...buttonProps} icon={<CallEnd01Icon />} label="Leave call" danger />} /> : null}
          </div>
        </div>
      );
    }
  },
);

export function ControlBar(props: ControlBarProps): React.JSX.Element {
  const { surfaceProps, commandError } = useConnectedControlBarBehavior(props);

  return (
    <>
      <ControlBarSurface {...surfaceProps} />
      {!props.onCommandError ? <CommandErrorAlert message={commandError ?? undefined} /> : null}
    </>
  );
}

ControlBar.displayName = "ControlBar";
