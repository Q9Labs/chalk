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
	hideOverlay,
}: {
	source: PictureInPictureSource | null;
	className?: string;
	hideOverlay?: boolean;
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
			{!hideOverlay ? (
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
			) : null}
		</div>
	);
}

export function PictureInPictureWindow({
	phase,
	roomName,
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
		<div className="group relative flex min-h-screen flex-col overflow-hidden bg-[#050911] text-neutral-50 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.05)]">
			{/* Full bleed stage */}
			<div className="absolute inset-0 z-0">
				<PictureInPictureStage source={source} className="h-full w-full rounded-none border-0" hideOverlay />
			</div>

			{/* Top Bar (Glass) */}
			<div className="absolute inset-x-0 top-0 z-10 flex items-start justify-between gap-4 bg-gradient-to-b from-black/80 via-black/30 to-transparent p-4 opacity-0 transition-opacity duration-300 group-hover:opacity-100">
				<div className="min-w-0 flex-1">
					<p className="truncate text-[13px] font-medium text-white drop-shadow-md">
						{source?.title ?? "Waiting for video"}
					</p>
					{source?.subtitle ? (
						<p className="truncate text-[11px] font-medium text-white/70 drop-shadow-md">
							{source.subtitle}
						</p>
					) : null}
					{source?.isMuted ? (
						<div className="mt-1.5 inline-flex rounded-full bg-black/60 px-2.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.2em] text-white/90 backdrop-blur-md">
							Muted
						</div>
					) : null}
				</div>
				<div className="min-w-0 shrink-0 text-right">
					<p className="truncate text-[11px] font-medium text-white/90 drop-shadow-md">
						{roomName ?? "Meeting"}
					</p>
					<p className="truncate text-[9px] font-semibold uppercase tracking-[0.2em] text-white/60 drop-shadow-md">
						{phase === "prejoin" ? "Ready" : "PIP"}
					</p>
				</div>
			</div>

			{/* Preview */}
			{phase === "meeting" && previewSource ? (
				<div className="pointer-events-none absolute bottom-20 right-4 z-10 h-28 w-20 overflow-hidden rounded-xl border border-white/10 bg-black/40 shadow-2xl backdrop-blur-md transition-all duration-300 group-hover:-translate-y-1">
					<PictureInPictureStage source={previewSource} className="h-full w-full rounded-none border-0" hideOverlay />
				</div>
			) : null}

			{/* Controls (Glass) */}
			<div className="absolute inset-x-0 bottom-6 z-20 flex justify-center translate-y-2 opacity-0 transition-all duration-300 group-hover:translate-y-0 group-hover:opacity-100">
				<div className="flex flex-wrap items-center justify-center gap-1.5 rounded-full border border-white/10 bg-black/40 px-3 py-2 shadow-2xl backdrop-blur-2xl">
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
