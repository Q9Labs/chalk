import { useEffect, useMemo, useRef } from "react";

import { Avatar, ControlButton } from "../../atomic";
import { cn } from "../../../utils/cn";
import {
	Edit02Icon,
	HandIcon,
	Home01Icon,
	Message01Icon,
	Microphone01Icon,
	MicrophoneOff01Icon,
	Monitor01Icon,
	MonitorOffIcon,
	Video01Icon,
	VideoOffIcon,
	CallEnd01Icon,
} from "../../../utils/icons";
import type {
	PictureInPictureControls,
	PictureInPicturePhase,
	PictureInPictureSource,
} from "./types";

interface PictureInPictureWindowProps {
	phase: PictureInPicturePhase;
	roomName?: string;
	displayName?: string;
	source: PictureInPictureSource | null;
	previewSource?: PictureInPictureSource | null;
	controls: PictureInPictureControls;
	onReturnToTab: () => void;
}

function PictureInPictureStage({
	source,
	className,
}: {
	source: PictureInPictureSource | null;
	className?: string;
}) {
	const videoRef = useRef<HTMLVideoElement>(null);
	const hasVideo = Boolean(source?.videoTrack);

	useEffect(() => {
		const videoElement = videoRef.current;
		const track = source?.videoTrack;

		if (!videoElement) {
			return;
		}

		if (!track || track.readyState === "ended") {
			videoElement.srcObject = null;
			return;
		}

		videoElement.srcObject = new MediaStream([track]);
		void videoElement.play().catch(() => {});

		return () => {
			videoElement.srcObject = null;
		};
	}, [source?.videoTrack]);

	return (
		<div
			className={cn(
				"relative flex-1 overflow-hidden rounded-[24px] border border-white/10 bg-[radial-gradient(circle_at_top,#21354d_0%,#0b1220_58%,#060a12_100%)]",
				className,
			)}
		>
			{hasVideo ? (
				<video
					ref={videoRef}
					autoPlay
					playsInline
					muted
					className={cn(
						"h-full w-full",
						source?.kind === "screen-share" ? "object-contain bg-black" : "object-cover",
					)}
				/>
			) : (
				<div className="flex h-full w-full items-center justify-center">
					<Avatar
						name={source?.title ?? "Guest"}
						src={source?.avatarUrl}
						size="xl"
						className="scale-[1.25] shadow-2xl"
					/>
				</div>
			)}

			<div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent p-4">
				<div className="flex items-end justify-between gap-3">
					<div className="min-w-0">
						<p className="truncate text-base font-semibold text-white">
							{source?.title ?? "Waiting for video"}
						</p>
						{source?.subtitle ? (
							<p className="truncate text-xs text-white/70">{source.subtitle}</p>
						) : null}
					</div>
					{source?.isMuted ? (
						<div className="rounded-full bg-black/50 px-2 py-1 text-[10px] font-medium uppercase tracking-[0.18em] text-white/80">
							Muted
						</div>
					) : null}
				</div>
			</div>
		</div>
	);
}

export function PictureInPictureWindow({
	phase,
	roomName,
	displayName,
	source,
	previewSource,
	controls,
	onReturnToTab,
}: PictureInPictureWindowProps) {
	const actionButtons = useMemo(() => {
		if (phase === "prejoin") {
			return [
				{
					key: "mute",
					label: controls.isMuted ? "Unmute" : "Mute",
					icon: controls.isMuted ? <MicrophoneOff01Icon size={18} /> : <Microphone01Icon size={18} />,
					active: !controls.isMuted,
					onClick: controls.onToggleMute,
				},
				{
					key: "video",
					label: controls.isVideoEnabled ? "Stop Video" : "Start Video",
					icon: controls.isVideoEnabled ? <Video01Icon size={18} /> : <VideoOffIcon size={18} />,
					active: controls.isVideoEnabled,
					onClick: controls.onToggleVideo,
				},
				{
					key: "return",
					label: "Return to tab",
					icon: <Home01Icon size={18} />,
					active: true,
					activeClassName:
						"bg-white/12 text-white hover:bg-white/18 border border-white/10",
					onClick: onReturnToTab,
				},
			];
		}

		return [
			{
				key: "mute",
				label: controls.isMuted ? "Unmute" : "Mute",
				icon: controls.isMuted ? <MicrophoneOff01Icon size={18} /> : <Microphone01Icon size={18} />,
				active: !controls.isMuted,
				onClick: controls.onToggleMute,
			},
			{
				key: "video",
				label: controls.isVideoEnabled ? "Stop Video" : "Start Video",
				icon: controls.isVideoEnabled ? <Video01Icon size={18} /> : <VideoOffIcon size={18} />,
				active: controls.isVideoEnabled,
				onClick: controls.onToggleVideo,
			},
			controls.enableScreenShare && controls.onToggleScreenShare
				? {
						key: "screenshare",
						label: controls.isScreenSharing ? "Stop Share" : "Share Screen",
						icon: controls.isScreenSharing ? <MonitorOffIcon size={18} /> : <Monitor01Icon size={18} />,
						active: controls.isScreenSharing,
						onClick: controls.onToggleScreenShare,
					}
				: null,
			controls.enableHandRaise && controls.onToggleHandRaise
				? {
						key: "handraise",
						label: controls.isHandRaised ? "Lower Hand" : "Raise Hand",
						icon: <HandIcon size={18} />,
						active: controls.isHandRaised,
						onClick: controls.onToggleHandRaise,
					}
				: null,
			controls.enableWhiteboard && controls.onToggleWhiteboard
				? {
						key: "whiteboard",
						label: "Whiteboard",
						icon: <Edit02Icon size={18} />,
						active: controls.isWhiteboardOpen,
						onClick: controls.onToggleWhiteboard,
					}
				: null,
			controls.enableReactions && controls.onOpenReactions
				? {
						key: "reactions",
						label: "Reactions",
						icon: <Message01Icon size={18} />,
						active: false,
						activeClassName:
							"bg-white/12 text-white hover:bg-white/18 border border-white/10",
						onClick: controls.onOpenReactions,
					}
				: null,
			{
				key: "return",
				label: "Return to tab",
				icon: <Home01Icon size={18} />,
				active: true,
				activeClassName:
					"bg-white/12 text-white hover:bg-white/18 border border-white/10",
				onClick: onReturnToTab,
			},
			controls.onLeave
				? {
						key: "leave",
						label: "Leave meeting",
						icon: <CallEnd01Icon size={18} />,
						active: true,
						activeClassName:
							"bg-[#ef4444] text-white hover:bg-[#dc2626] border border-transparent",
						onClick: controls.onLeave,
					}
				: null,
		].filter(Boolean);
	}, [controls, onReturnToTab, phase]);

	return (
		<div className="flex min-h-screen flex-col gap-3 bg-[#050911] p-3 text-white">
			<div className="flex items-center justify-between gap-3 px-1">
				<div className="min-w-0">
					<p className="truncate text-sm font-semibold text-white">
						{roomName ?? "Meeting"}
					</p>
					<p className="truncate text-[11px] uppercase tracking-[0.16em] text-white/45">
						{phase === "prejoin" ? "Ready to join" : "Picture in Picture"}
					</p>
				</div>
				{displayName ? (
					<div className="truncate text-xs font-medium text-white/60">{displayName}</div>
				) : null}
			</div>

			<div className="relative flex flex-1 flex-col">
				<PictureInPictureStage source={source} />
				{phase === "meeting" && previewSource ? (
					<div className="pointer-events-none absolute bottom-4 right-4 h-20 w-16 overflow-hidden rounded-2xl border border-white/10 bg-black/30 shadow-xl">
						<PictureInPictureStage source={previewSource} className="rounded-none border-0" />
					</div>
				) : null}
			</div>

			<div className="rounded-[28px] border border-white/10 bg-white/6 px-3 py-2 shadow-[0_18px_48px_rgba(0,0,0,0.36)] backdrop-blur-xl">
				<div className="flex flex-wrap items-center justify-center gap-2">
					{actionButtons.map((button) =>
						button ? (
							<ControlButton
								key={button.key}
								icon={button.icon}
								label={button.label}
								active={button.active}
								onClick={button.onClick}
								size="sm"
								activeClassName={button.activeClassName}
							/>
						) : null,
					)}
				</div>
			</div>
		</div>
	);
}
