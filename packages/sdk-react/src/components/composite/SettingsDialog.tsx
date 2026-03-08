import { Dialog } from "@base-ui/react/dialog";
import React, { useEffect, useMemo, useState } from "react";

import type { MeetingRoomSettings } from "../../hooks/useMeetingRoomSettings";
import { usePrefersReducedMotion } from "../../hooks/useMediaQuery";
import { cn } from "../../utils/cn";
import { getParticipantThemeVariables } from "../../utils/colorGenerator";
import {
	Cancel01Icon,
	ColumnIcon,
	LayoutGridIcon,
	LayoutTableIcon,
	Message01Icon,
	Microphone01Icon,
	Monitor01Icon,
	Moon02Icon,
	Search01Icon,
	Settings01Icon,
	Sun02Icon,
	Video01Icon,
	VolumeHighIcon,
} from "../../utils/icons";
import { IconButton, Input, Toggle, VolumeSlider } from "../atomic";
import { DeviceSelector } from "./DeviceSelector";
import { NoiseSuppressionToggle } from "./NoiseSuppressionToggle";

type SectionId = "audio" | "video" | "appearance" | "experience";
type SelectableDevice = Pick<MediaDeviceInfo, "deviceId" | "kind" | "label">;

const EMPTY_DEVICE_GROUPS = {
	audioinput: [] as SelectableDevice[],
	audiooutput: [] as SelectableDevice[],
	videoinput: [] as SelectableDevice[],
};

function mergeDevices(
	...deviceGroups: ReadonlyArray<readonly SelectableDevice[]>
) {
	const devicesById = new Map<string, SelectableDevice>();

	for (const deviceGroup of deviceGroups) {
		for (const device of deviceGroup) {
			const existingDevice = devicesById.get(device.deviceId);
			if (!existingDevice || (!existingDevice.label && device.label)) {
				devicesById.set(device.deviceId, device);
			}
		}
	}

	return Array.from(devicesById.values());
}

interface SettingsDialogProps {
	isOpen: boolean;
	onClose: () => void;
	settings: MeetingRoomSettings;
	onUpdateAudio: (updates: Partial<MeetingRoomSettings["audio"]>) => void;
	onUpdateVideo: (updates: Partial<MeetingRoomSettings["video"]>) => void;
	onUpdateAppearance: (updates: Partial<MeetingRoomSettings["appearance"]>) => void;
	onUpdateExperience: (updates: Partial<MeetingRoomSettings["experience"]>) => void;
	audioInputDevices?: readonly Pick<MediaDeviceInfo, "deviceId" | "kind" | "label">[];
	audioOutputDevices?: readonly Pick<MediaDeviceInfo, "deviceId" | "kind" | "label">[];
	videoInputDevices?: readonly Pick<MediaDeviceInfo, "deviceId" | "kind" | "label">[];
	audioLevel?: number;
	videoTrack?: MediaStreamTrack | null;
	reducedMotion?: boolean;
	participantColorSeed?: string;
	className?: string;
}

const SECTIONS = [
	{
		id: "audio",
		label: "Audio",
		description: "Microphone, speakers, volume",
		icon: Microphone01Icon,
		keywords: ["mic", "microphone", "speaker", "volume", "noise"],
	},
	{
		id: "video",
		label: "Video",
		description: "Camera and preview",
		icon: Video01Icon,
		keywords: ["video", "camera", "preview"],
	},
	{
		id: "appearance",
		label: "Appearance",
		description: "Theme, layout, motion",
		icon: Monitor01Icon,
		keywords: ["theme", "layout", "filmstrip", "motion", "dark", "light"],
	},
	{
		id: "experience",
		label: "Experience",
		description: "Startup panels and invites",
		icon: Message01Icon,
		keywords: ["chat", "invite", "transcript", "startup", "defaults"],
	},
] as const satisfies ReadonlyArray<{
	id: SectionId;
	label: string;
	description: string;
	icon: React.ComponentType<{ className?: string }>;
	keywords: readonly string[];
}>;

function SectionCard({
	title,
	description,
	children,
}: {
	title: string;
	description: string;
	children: React.ReactNode;
}) {
	return (
		<section className="rounded-3xl border border-border/50 bg-background/70 p-5 shadow-sm">
			<div className="mb-4">
				<h3 className="text-sm font-semibold text-foreground">{title}</h3>
				<p className="mt-1 text-xs text-muted-foreground">{description}</p>
			</div>
			<div className="space-y-4">{children}</div>
		</section>
	);
}

function ToggleRow({
	title,
	description,
	checked,
	onChange,
}: {
	title: string;
	description: string;
	checked: boolean;
	onChange: (checked: boolean) => void;
}) {
	return (
		<div className="flex items-center justify-between gap-4 rounded-2xl border border-border/50 bg-card/60 p-4">
			<div>
				<div className="text-sm font-medium text-foreground">{title}</div>
				<div className="text-xs text-muted-foreground">{description}</div>
			</div>
			<Toggle checked={checked} onChange={onChange} />
		</div>
	);
}

export const SettingsDialog = React.memo(
	({
		isOpen,
		onClose,
		settings,
		onUpdateAudio,
		onUpdateVideo,
		onUpdateAppearance,
		onUpdateExperience,
		audioInputDevices = [],
		audioOutputDevices = [],
		videoInputDevices = [],
		audioLevel = 0,
		videoTrack,
		reducedMotion = false,
		participantColorSeed,
		className,
	}: SettingsDialogProps) => {
		const prefersReducedMotion = usePrefersReducedMotion();
		const disableMotion = prefersReducedMotion || reducedMotion;
		const [activeSection, setActiveSection] = useState<SectionId>("audio");
		const [searchQuery, setSearchQuery] = useState("");
		const [detectedDevices, setDetectedDevices] = useState(EMPTY_DEVICE_GROUPS);
		const themeVariables = useMemo(
			() => getParticipantThemeVariables(participantColorSeed),
			[participantColorSeed],
		);
		const effectiveAudioInputDevices = useMemo(
			() => mergeDevices(audioInputDevices, detectedDevices.audioinput),
			[audioInputDevices, detectedDevices.audioinput],
		);
		const effectiveAudioOutputDevices = useMemo(
			() => mergeDevices(audioOutputDevices, detectedDevices.audiooutput),
			[audioOutputDevices, detectedDevices.audiooutput],
		);
		const effectiveVideoInputDevices = useMemo(
			() => mergeDevices(videoInputDevices, detectedDevices.videoinput),
			[detectedDevices.videoinput, videoInputDevices],
		);

		const filteredSections = useMemo(() => {
			if (!searchQuery.trim()) {
				return SECTIONS;
			}

			const query = searchQuery.toLowerCase();
			return SECTIONS.filter((section) => {
				return (
					section.label.toLowerCase().includes(query) ||
					section.description.toLowerCase().includes(query) ||
					section.keywords.some((keyword) => keyword.includes(query))
				);
			});
		}, [searchQuery]);

		useEffect(() => {
			if (!filteredSections.some((section) => section.id === activeSection)) {
				setActiveSection(filteredSections[0]?.id ?? "audio");
			}
		}, [activeSection, filteredSections]);

		useEffect(() => {
			if (!isOpen) {
				return;
			}

			const mediaDevices = navigator.mediaDevices;
			if (!mediaDevices?.enumerateDevices) {
				return;
			}

			let isCancelled = false;

			const syncDevices = async () => {
				try {
					const devices = await mediaDevices.enumerateDevices();
					if (isCancelled) {
						return;
					}

					setDetectedDevices({
						audioinput: devices.filter(
							(device) => device.kind === "audioinput",
						),
						audiooutput: devices.filter(
							(device) => device.kind === "audiooutput",
						),
						videoinput: devices.filter(
							(device) => device.kind === "videoinput",
						),
					});
				} catch {
					// Keep prop-driven device lists if enumeration fails.
				}
			};

			void syncDevices();
			mediaDevices.addEventListener?.("devicechange", syncDevices);

			return () => {
				isCancelled = true;
				mediaDevices.removeEventListener?.("devicechange", syncDevices);
			};
		}, [isOpen]);

		const renderSectionContent = () => {
			switch (activeSection) {
				case "audio":
					return (
						<div className="space-y-5">
							<SectionCard
								title="Microphone"
								description="Choose the live input device and clean up background noise."
							>
								<DeviceSelector
									type="audioinput"
									devices={effectiveAudioInputDevices}
									selectedDeviceId={settings.audio.selectedInput}
									onChange={(deviceId) =>
										onUpdateAudio({ selectedInput: deviceId })
									}
									label="Input device"
									audioLevel={audioLevel}
									participantColorSeed={participantColorSeed}
								/>
								<NoiseSuppressionToggle
									enabled={settings.audio.noiseSuppression}
									onChange={(enabled) =>
										onUpdateAudio({ noiseSuppression: enabled })
									}
									level="medium"
								/>
							</SectionCard>

							<SectionCard
								title="Speakers"
								description="Route audio where you want it and tune playback volume."
							>
								<DeviceSelector
									type="audiooutput"
									devices={effectiveAudioOutputDevices}
									selectedDeviceId={settings.audio.selectedOutput}
									onChange={(deviceId) =>
										onUpdateAudio({ selectedOutput: deviceId })
									}
									label="Output device"
									participantColorSeed={participantColorSeed}
								/>
								<div className="rounded-2xl border border-border/50 bg-card/60 p-4">
									<div className="mb-3 flex items-center gap-2 text-sm font-medium text-foreground">
										<VolumeHighIcon className="h-4 w-4 text-primary" />
										Output volume
									</div>
									<VolumeSlider
										value={settings.audio.outputVolume}
										onChange={(value) => onUpdateAudio({ outputVolume: value })}
										showValue
									/>
								</div>
							</SectionCard>
						</div>
					);
				case "video":
					return (
						<SectionCard
							title="Camera"
							description="Pick the active camera and confirm the preview before teaching."
						>
							<DeviceSelector
								type="videoinput"
								devices={effectiveVideoInputDevices}
								selectedDeviceId={settings.video.selectedInput}
								onChange={(deviceId) =>
									onUpdateVideo({ selectedInput: deviceId })
								}
								label="Camera"
								previewTrack={videoTrack}
								participantColorSeed={participantColorSeed}
							/>
						</SectionCard>
					);
				case "appearance":
					return (
						<div className="space-y-5">
							<SectionCard
								title="Theme"
								description="Switch the room between light, dark, or follow the system."
							>
								<div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
									{([
										["light", Sun02Icon, "Light"],
										["dark", Moon02Icon, "Dark"],
										["system", Monitor01Icon, "System"],
									] as const).map(([value, Icon, label]) => (
										<button
											key={value}
											type="button"
											onClick={() => onUpdateAppearance({ theme: value })}
											className={cn(
												"rounded-2xl border p-4 text-left transition-colors",
												settings.appearance.theme === value
													? "border-primary bg-primary/10 text-primary"
													: "border-border/50 bg-card/60 text-foreground hover:border-primary/40",
											)}
										>
											<Icon className="mb-3 h-5 w-5" />
											<div className="text-sm font-semibold">{label}</div>
										</button>
									))}
								</div>
							</SectionCard>

							<SectionCard
								title="Layout"
								description="Persist the room composition you want to land in first."
							>
								<div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
									{([
										["grid", LayoutGridIcon, "Grid"],
										["spotlight", LayoutTableIcon, "Spotlight"],
										["sidebar", ColumnIcon, "Sidebar"],
									] as const).map(([value, Icon, label]) => (
										<button
											key={value}
											type="button"
											onClick={() => onUpdateAppearance({ layout: value })}
											className={cn(
												"rounded-2xl border p-4 text-left transition-colors",
												settings.appearance.layout === value
													? "border-primary bg-primary/10 text-primary"
													: "border-border/50 bg-card/60 text-foreground hover:border-primary/40",
											)}
										>
											<Icon className="mb-3 h-5 w-5" />
											<div className="text-sm font-semibold">{label}</div>
										</button>
									))}
								</div>
								<ToggleRow
									title="Show filmstrip"
									description="Keep the participant strip visible by default."
									checked={settings.appearance.showFilmstrip}
									onChange={(checked) =>
										onUpdateAppearance({ showFilmstrip: checked })
									}
								/>
								<ToggleRow
									title="Reduced motion"
									description="Turn down transitions and ambient motion."
									checked={settings.appearance.reducedMotion}
									onChange={(checked) =>
										onUpdateAppearance({ reducedMotion: checked })
									}
								/>
							</SectionCard>
						</div>
					);
				case "experience":
					return (
						<div className="space-y-5">
							<SectionCard
								title="Entry defaults"
								description="Choose what opens by default the next time you enter a room."
							>
								<ToggleRow
									title="Show invite toast"
									description="Keep the share reminder visible when the room loads."
									checked={settings.experience.showInviteToast}
									onChange={(checked) =>
										onUpdateExperience({ showInviteToast: checked })
									}
								/>
								<ToggleRow
									title="Open chat by default"
									description="Start with the chat drawer open."
									checked={settings.experience.defaultOpenChat}
									onChange={(checked) =>
										onUpdateExperience({ defaultOpenChat: checked })
									}
								/>
								<ToggleRow
									title="Open people by default"
									description="Start with the participant list open."
									checked={settings.experience.defaultOpenParticipants}
									onChange={(checked) =>
										onUpdateExperience({
											defaultOpenParticipants: checked,
										})
									}
								/>
								<ToggleRow
									title="Open transcript by default"
									description="Start with the transcript panel open."
									checked={settings.experience.defaultOpenTranscription}
									onChange={(checked) =>
										onUpdateExperience({
											defaultOpenTranscription: checked,
										})
									}
								/>
							</SectionCard>
						</div>
					);
			}
		};

		return (
			<Dialog.Root
				open={isOpen}
				onOpenChange={(open) => {
					if (!open) {
						onClose();
					}
				}}
			>
				<Dialog.Portal>
					<Dialog.Backdrop
						className={cn(
							"fixed inset-0 z-[100] bg-background/80 backdrop-blur-sm",
							!disableMotion && "animate-in fade-in duration-200",
						)}
					/>
					<Dialog.Popup
						className={cn(
							"fixed inset-x-4 top-1/2 z-[101] max-h-[min(720px,calc(100vh-2rem))] -translate-y-1/2 overflow-hidden rounded-[28px] border border-border/60 bg-card text-card-foreground shadow-2xl md:left-1/2 md:right-auto md:w-[min(960px,calc(100vw-3rem))] md:-translate-x-1/2",
							!disableMotion &&
								"animate-in fade-in zoom-in-[0.98] slide-in-from-bottom-4 duration-200",
							className,
						)}
						style={themeVariables as React.CSSProperties}
					>
						<Dialog.Title className="sr-only">Meeting settings</Dialog.Title>
						<div className="flex max-h-[inherit] flex-col md:flex-row">
							<aside className="w-full border-b border-border/50 bg-secondary/20 md:w-[280px] md:border-b-0 md:border-r">
								<div className="p-5">
									<div className="mb-5 flex items-center gap-2">
										<Settings01Icon className="h-5 w-5 text-primary" />
										<div>
											<div className="text-base font-semibold">Settings</div>
											<div className="text-xs text-muted-foreground">
												Local to this browser
											</div>
										</div>
									</div>
									<Input
										value={searchQuery}
										onChange={(event) => setSearchQuery(event.target.value)}
										placeholder="Search settings"
										icon={<Search01Icon className="h-4 w-4" />}
										fullWidth
										className="rounded-2xl border-border/50 bg-background/80"
										aria-label="Search settings"
									/>
								</div>
								<nav className="space-y-1 px-3 pb-4">
									{filteredSections.map((section) => {
										const Icon = section.icon;

										return (
											<button
												key={section.id}
												type="button"
												onClick={() => setActiveSection(section.id)}
												className={cn(
													"flex w-full items-start gap-3 rounded-2xl px-4 py-3 text-left transition-colors",
													activeSection === section.id
														? "bg-primary text-primary-foreground shadow-md shadow-primary/20"
														: "text-muted-foreground hover:bg-background/80 hover:text-foreground",
												)}
											>
												<Icon className="mt-0.5 h-4 w-4 shrink-0" />
												<span className="min-w-0">
													<span className="block text-sm font-medium">
														{section.label}
													</span>
													<span className="block text-xs opacity-80">
														{section.description}
													</span>
												</span>
											</button>
										);
									})}
									{filteredSections.length === 0 && (
										<div className="rounded-2xl border border-dashed border-border/60 px-4 py-6 text-center text-sm text-muted-foreground">
											No matching settings.
										</div>
									)}
								</nav>
							</aside>

							<div className="flex min-h-0 flex-1 flex-col">
								<div className="flex items-start justify-between border-b border-border/50 px-5 py-5 md:px-7">
									<div>
										<h2 className="text-xl font-semibold text-foreground">
											{SECTIONS.find((section) => section.id === activeSection)?.label}
										</h2>
										<p className="mt-1 text-sm text-muted-foreground">
											{SECTIONS.find((section) => section.id === activeSection)?.description}
										</p>
									</div>
									<IconButton
										icon={<Cancel01Icon className="h-5 w-5" />}
										variant="ghost"
										onClick={onClose}
										aria-label="Close settings"
									/>
								</div>
								<div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 md:px-7">
									<div className="mx-auto max-w-[560px]">{renderSectionContent()}</div>
								</div>
							</div>
						</div>
					</Dialog.Popup>
				</Dialog.Portal>
			</Dialog.Root>
		);
	},
);

SettingsDialog.displayName = "SettingsDialog";
