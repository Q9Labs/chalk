import type React from "react";
import { useMemo, type RefObject } from "react";

import {
	ArrowDown01Icon,
	Microphone01Icon,
	MicrophoneOff01Icon,
	MoreVerticalIcon,
	PictureInPictureIcon,
	Video01Icon,
	VideoOffIcon,
} from "../../../utils/icons";
import { cn } from "../../../utils/cn";
import type { PreJoinDropdown } from "./usePreJoinUiState";

const AUDIO_DEVICE_MENU_ID = "prejoin-audio-device-menu";
const VIDEO_DEVICE_MENU_ID = "prejoin-video-device-menu";

interface PreJoinFloatingControlsProps {
	dropdownRef: RefObject<HTMLDivElement | null>;
	openDropdown: PreJoinDropdown;
	setOpenDropdown: (value: PreJoinDropdown) => void;
	isAudioEnabled: boolean;
	isVideoEnabled: boolean;
	hasAudioInput: boolean;
	hasVideoDevices: boolean;
	effectiveAudioInputDevices: MediaDeviceInfo[];
	effectiveVideoDevices: MediaDeviceInfo[];
	selectedAudioInput?: string;
	selectedVideoDevice?: string;
	onAudioInputChange: (deviceId: string) => void;
	onVideoDeviceChange: (deviceId: string) => void;
	onToggleAudio: () => void;
	onToggleVideo: () => void;
	onToggleSettings: () => void;
	enablePictureInPicture?: boolean;
	isPictureInPictureSupported?: boolean;
	isPictureInPictureActive?: boolean;
	onTogglePictureInPicture?: () => Promise<void> | void;
}

export function PreJoinFloatingControls({
	dropdownRef,
	openDropdown,
	setOpenDropdown,
	isAudioEnabled,
	isVideoEnabled,
	hasAudioInput,
	hasVideoDevices,
	effectiveAudioInputDevices,
	effectiveVideoDevices,
	selectedAudioInput,
	selectedVideoDevice,
	onAudioInputChange,
	onVideoDeviceChange,
	onToggleAudio,
	onToggleVideo,
	onToggleSettings,
	enablePictureInPicture = false,
	isPictureInPictureSupported = false,
	isPictureInPictureActive = false,
	onTogglePictureInPicture,
}: PreJoinFloatingControlsProps): React.JSX.Element {
	const selectedAudioInputDevice = useMemo(
		() =>
			effectiveAudioInputDevices.find(
				(device) => device.deviceId === selectedAudioInput,
			),
		[effectiveAudioInputDevices, selectedAudioInput],
	);
	const selectedVideoDeviceInfo = useMemo(
		() =>
			effectiveVideoDevices.find((device) => device.deviceId === selectedVideoDevice),
		[effectiveVideoDevices, selectedVideoDevice],
	);
	const dropdownDevices =
		openDropdown === "audio" ? effectiveAudioInputDevices : effectiveVideoDevices;

	return (
		<div
			className="absolute bottom-4 left-1/2 -translate-x-1/2 z-40 flex flex-col items-center gap-3 touch-manipulation"
			ref={dropdownRef}
		>
			<div className="flex gap-4 px-4 py-1.5 rounded-full bg-black/40 backdrop-blur-md border border-white/10 opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none">
				{isAudioEnabled && selectedAudioInputDevice && (
					<span className="text-[10px] text-white/70 font-medium tracking-wide uppercase truncate max-w-[120px]">
						Mic: {selectedAudioInputDevice.label || "Default"}
					</span>
				)}
				{isVideoEnabled && selectedVideoDeviceInfo && (
					<span className="text-[10px] text-white/70 font-medium tracking-wide uppercase truncate max-w-[120px]">
						Cam: {selectedVideoDeviceInfo.label || "Default"}
					</span>
				)}
			</div>

			{openDropdown && (
				<div
					id={openDropdown === "audio" ? AUDIO_DEVICE_MENU_ID : VIDEO_DEVICE_MENU_ID}
					role="menu"
					aria-label={
						openDropdown === "audio" ? "Microphone devices" : "Camera devices"
					}
					className="absolute bottom-full mb-14 w-64 rounded-xl border border-white/10 shadow-2xl overflow-hidden animate-in slide-in-from-bottom-2 duration-200"
					style={{
						left: openDropdown === "audio" ? "0" : "auto",
						right: openDropdown === "video" ? "0" : "auto",
						background: "rgba(30, 30, 30, 0.95)",
						backdropFilter: "blur(20px)",
					}}
				>
					<div className="px-3 py-3 text-xs font-semibold text-white/60 uppercase tracking-wide border-b border-white/10">
						{openDropdown === "audio" ? "Microphone" : "Camera"}
					</div>
					<div className="py-2 max-h-[240px] overflow-y-auto">
						{dropdownDevices.map((device) => {
							const isSelected =
								openDropdown === "audio"
									? selectedAudioInput === device.deviceId
									: selectedVideoDevice === device.deviceId;
							return (
								<button
									type="button"
									key={device.deviceId}
									role="menuitemradio"
									aria-checked={isSelected}
									onClick={() => {
										if (openDropdown === "audio") {
											onAudioInputChange(device.deviceId);
										} else {
											onVideoDeviceChange(device.deviceId);
										}
										setOpenDropdown(null);
									}}
									className={cn(
										"w-full px-3 py-2.5 text-left text-sm transition-colors flex items-center gap-3 outline-none focus-visible:bg-white/10",
										isSelected
											? "bg-[var(--primary)]/20 text-[var(--primary)]"
											: "text-white/90 hover:bg-white/10",
									)}
								>
									{isSelected && (
										<span className="w-1.5 h-1.5 rounded-full bg-[var(--primary)] shrink-0" />
									)}
									<span className={cn("truncate", !isSelected && "ml-[18px]")}>
										{device.label ||
											`${openDropdown === "audio" ? "Microphone" : "Camera"} ${device.deviceId.slice(0, 5)}`}
									</span>
								</button>
							);
						})}
					</div>
				</div>
			)}

			<div
				className="flex items-center gap-4 px-3 py-2 rounded-full relative group"
				style={{
					background: "var(--chalk-lobby-glass-bg)",
					backdropFilter: "blur(20px)",
					border: "1px solid var(--chalk-lobby-glass-border)",
					boxShadow: "var(--chalk-shadow-md)",
				}}
			>
				<div className="flex items-center gap-1">
					<button
						type="button"
						onClick={onToggleAudio}
						title={isAudioEnabled ? "Mute microphone" : "Unmute microphone"}
						aria-label={isAudioEnabled ? "Mute microphone" : "Unmute microphone"}
						className={cn(
							"w-11 h-11 rounded-full flex items-center justify-center transition-all duration-200 outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)] active:scale-90 touch-manipulation",
							!isAudioEnabled
								? "bg-red-500 text-white hover:bg-red-600"
								: "bg-black/5 dark:bg-white/10 text-(--foreground) hover:bg-black/10 dark:hover:bg-white/20",
						)}
					>
						{isAudioEnabled ? (
							<Microphone01Icon size={20} />
						) : (
							<MicrophoneOff01Icon size={20} />
						)}
					</button>
					{hasAudioInput && (
						<button
							type="button"
							onClick={(event) => {
								event.stopPropagation();
								setOpenDropdown(openDropdown === "audio" ? null : "audio");
							}}
							title="Select microphone"
							aria-label="Select microphone"
							aria-haspopup="menu"
							aria-controls={AUDIO_DEVICE_MENU_ID}
							aria-expanded={openDropdown === "audio"}
							className={cn(
								"w-8 h-11 rounded-r-full -ml-1 flex items-center justify-center transition-all duration-200 outline-none focus-visible:bg-[var(--primary)]/10",
								openDropdown === "audio"
									? "text-[var(--primary)]"
									: "text-(--muted-foreground) hover:text-(--foreground) hover:bg-black/5 dark:hover:bg-white/5",
							)}
						>
							<ArrowDown01Icon
								size={14}
								className={cn(
									"transition-transform",
									openDropdown === "audio" && "rotate-180",
								)}
							/>
						</button>
					)}
				</div>

				<div className="flex items-center gap-1">
					<button
						type="button"
						onClick={onToggleVideo}
						title={isVideoEnabled ? "Turn off camera" : "Turn on camera"}
						aria-label={isVideoEnabled ? "Turn off camera" : "Turn on camera"}
						className={cn(
							"w-11 h-11 rounded-full flex items-center justify-center transition-all duration-200 outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)] active:scale-90 touch-manipulation",
							!isVideoEnabled
								? "bg-red-500 text-white hover:bg-red-600"
								: "bg-black/5 dark:bg-white/10 text-(--foreground) hover:bg-black/10 dark:hover:bg-white/20",
						)}
					>
						{isVideoEnabled ? <Video01Icon size={20} /> : <VideoOffIcon size={20} />}
					</button>
					{hasVideoDevices && (
						<button
							type="button"
							onClick={(event) => {
								event.stopPropagation();
								setOpenDropdown(openDropdown === "video" ? null : "video");
							}}
							title="Select camera"
							aria-label="Select camera"
							aria-haspopup="menu"
							aria-controls={VIDEO_DEVICE_MENU_ID}
							aria-expanded={openDropdown === "video"}
							className={cn(
								"w-8 h-11 rounded-r-full -ml-1 flex items-center justify-center transition-all duration-200 outline-none focus-visible:bg-[var(--primary)]/10",
								openDropdown === "video"
									? "text-[var(--primary)]"
									: "text-(--muted-foreground) hover:text-(--foreground) hover:bg-black/5 dark:hover:bg-white/5",
							)}
						>
							<ArrowDown01Icon
								size={14}
								className={cn(
									"transition-transform",
									openDropdown === "video" && "rotate-180",
								)}
							/>
						</button>
					)}
				</div>

				<div className="w-px h-6 bg-black/10 dark:bg-white/20 mx-1" />

				<button
					type="button"
					onClick={onToggleSettings}
					title="Settings"
					aria-label="Settings"
					className="w-11 h-11 rounded-full flex items-center justify-center bg-black/5 dark:bg-white/10 text-(--foreground) hover:bg-black/10 dark:hover:bg-white/20 transition-all duration-200 outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)] active:scale-90"
				>
					<MoreVerticalIcon size={18} />
				</button>
				{enablePictureInPicture && isPictureInPictureSupported && onTogglePictureInPicture ? (
					<button
						type="button"
						onClick={() => {
							void onTogglePictureInPicture();
						}}
						title={
							isPictureInPictureActive
								? "Close picture in picture"
								: "Open picture in picture"
						}
						aria-label={
							isPictureInPictureActive
								? "Close picture in picture"
								: "Open picture in picture"
						}
						className={cn(
							"w-11 h-11 rounded-full flex items-center justify-center transition-all duration-200 outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)] active:scale-90",
							isPictureInPictureActive
								? "bg-[var(--primary)] text-white"
								: "bg-black/5 dark:bg-white/10 text-(--foreground) hover:bg-black/10 dark:hover:bg-white/20",
						)}
					>
						<PictureInPictureIcon size={18} />
					</button>
				) : null}
			</div>
		</div>
	);
}
