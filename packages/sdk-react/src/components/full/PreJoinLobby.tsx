import {
	Microphone01Icon,
	MicrophoneOff01Icon,
	MoreVerticalIcon,
	Video01Icon,
	VideoOffIcon,
	Cancel01Icon,
	Sun02Icon,
	Moon02Icon,
	ArrowDown01Icon,
} from "../../utils/icons";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../../utils/cn";
import { Avatar, Toast } from "../atomic";
import { DeviceSelector } from "../composite";
import { LoadingScreen } from "./LoadingScreen";
import { getParticipantGradient } from "../../utils/colorGenerator";

export interface JoinSettings {
	displayName: string;
	videoEnabled: boolean;
	audioEnabled: boolean;
	selectedVideoDevice?: string;
	selectedAudioInput?: string;
	selectedAudioOutput?: string;
}

export interface PreJoinLobbyProps {
	roomName?: string;
	userName?: string;
	onJoin: (settings: JoinSettings) => void;
	onCancel?: () => void;

	videoTrack?: MediaStreamTrack | null;
	audioTrack?: MediaStreamTrack | null;
	audioLevel?: number;

	videoDevices?: MediaDeviceInfo[];
	audioInputDevices?: MediaDeviceInfo[];
	audioOutputDevices?: MediaDeviceInfo[];
	selectedVideoDevice?: string;
	selectedAudioInput?: string;
	selectedAudioOutput?: string;
	onVideoDeviceChange?: (deviceId: string) => void;
	onAudioInputChange?: (deviceId: string) => void;
	onAudioOutputChange?: (deviceId: string) => void;

	initialVideoEnabled?: boolean;
	initialAudioEnabled?: boolean;
	initialShowSettings?: boolean;

	isLoading?: boolean;
	error?: string;

	/** Initial theme - defaults to 'dark' */
	initialTheme?: "light" | "dark";

	className?: string;
}

function PreJoinLobbyBase({
	roomName,
	userName = "Guest",
	onJoin,
	videoTrack,
	audioLevel = 0,
	videoDevices = [],
	audioInputDevices = [],
	audioOutputDevices = [],
	selectedVideoDevice,
	selectedAudioInput,
	selectedAudioOutput,
	onVideoDeviceChange = () => {},
	onAudioInputChange = () => {},
	onAudioOutputChange = () => {},
	initialVideoEnabled = true,
	initialAudioEnabled = true,
	initialShowSettings = false,
	isLoading = false,
	error,
	initialTheme = "dark",
	className,
}: PreJoinLobbyProps) {
	const [displayName, setDisplayName] = useState(userName);
	const [isVideoEnabled, setIsVideoEnabled] = useState(initialVideoEnabled);
	const [isAudioEnabled, setIsAudioEnabled] = useState(initialAudioEnabled);
	const [showSettings, setShowSettings] = useState(initialShowSettings);
	const [isDarkMode, setIsDarkMode] = useState(() => {
		// Sync with document theme if available (for app integration)
		if (typeof document !== "undefined") {
			return document.documentElement.classList.contains("dark");
		}
		return initialTheme === "dark";
	});
	const [openDropdown, setOpenDropdown] = useState<"audio" | "video" | null>(null);
	const videoRef = useRef<HTMLVideoElement>(null);
	const containerRef = useRef<HTMLDivElement>(null);
	const dropdownRef = useRef<HTMLDivElement>(null);

	// Local media state (used when no external track is provided)
	const [localVideoTrack, setLocalVideoTrack] =
		useState<MediaStreamTrack | null>(null);
	const [localAudioTrack, setLocalAudioTrack] =
		useState<MediaStreamTrack | null>(null);
	const [localAudioLevel, setLocalAudioLevel] = useState(0);

	// Local device enumeration (used when parent doesn't provide devices)
	const [localVideoDevices, setLocalVideoDevices] = useState<MediaDeviceInfo[]>([]);
	const [localAudioInputDevices, setLocalAudioInputDevices] = useState<MediaDeviceInfo[]>([]);

	// Use provided track or local track
	const activeVideoTrack = videoTrack ?? localVideoTrack;
	const activeAudioLevel = audioLevel || localAudioLevel;

	// Use provided devices or locally enumerated devices
	const effectiveVideoDevices = useMemo(() => videoDevices.length > 0 ? videoDevices : localVideoDevices, [videoDevices, localVideoDevices]);
	const effectiveAudioInputDevices = useMemo(() => audioInputDevices.length > 0 ? audioInputDevices : localAudioInputDevices, [audioInputDevices, localAudioInputDevices]);

	// Enumerate devices
	const enumerateDevices = useCallback(async () => {
		try {
			const devices = await navigator.mediaDevices.enumerateDevices();
			setLocalVideoDevices(devices.filter((d) => d.kind === "videoinput"));
			setLocalAudioInputDevices(devices.filter((d) => d.kind === "audioinput"));
		} catch {
			// Ignore enumeration errors
		}
	}, []);

	// Enumerate devices on mount (labels may be empty until permissions granted)
	useEffect(() => {
		enumerateDevices();
		// Also listen for device changes
		navigator.mediaDevices?.addEventListener("devicechange", enumerateDevices);
		return () => {
			navigator.mediaDevices?.removeEventListener("devicechange", enumerateDevices);
		};
	}, [enumerateDevices]);

	// Request local video when enabled (only if no external track provided)
	useEffect(() => {
		if (!isVideoEnabled || videoTrack) {
			// Stop local track if we're disabling or have external track
			if (localVideoTrack && !videoTrack) {
				localVideoTrack.stop();
				setLocalVideoTrack(null);
			}
			return;
		}

		let cancelled = false;
		navigator.mediaDevices
			.getUserMedia({
				video: selectedVideoDevice
					? { deviceId: { exact: selectedVideoDevice } }
					: true,
			})
			.then((stream) => {
				if (cancelled) {
					stream.getTracks().forEach((t) => { t.stop(); });
					return;
				}
				const track = stream.getVideoTracks()[0];
				if (track) {
					setLocalVideoTrack(track);
					// Enumerate devices after getting permission
					enumerateDevices();
				}
			})
			.catch(() => {
				// Permission denied or error - just disable video
				if (!cancelled) setIsVideoEnabled(false);
			});

		return () => {
			cancelled = true;
		};
	}, [isVideoEnabled, videoTrack, selectedVideoDevice, enumerateDevices, localVideoTrack]);

	// Request local audio when enabled (only if no external track provided)
	useEffect(() => {
		if (!isAudioEnabled) {
			if (localAudioTrack) {
				localAudioTrack.stop();
				setLocalAudioTrack(null);
			}
			return;
		}

		let cancelled = false;
		navigator.mediaDevices
			.getUserMedia({
				audio: selectedAudioInput
					? { deviceId: { exact: selectedAudioInput } }
					: true,
			})
			.then((stream) => {
				if (cancelled) {
					stream.getTracks().forEach((t) => { t.stop(); });
					return;
				}
				const track = stream.getAudioTracks()[0];
				if (track) {
					setLocalAudioTrack(track);
					// Enumerate devices after getting permission
					enumerateDevices();
				}
			})
			.catch(() => {
				if (!cancelled) setIsAudioEnabled(false);
			});

		return () => {
			cancelled = true;
		};
	}, [isAudioEnabled, selectedAudioInput, enumerateDevices, localAudioTrack]);

	// Audio level monitoring
	useEffect(() => {
		const track = localAudioTrack;
		if (!track || !isAudioEnabled) {
			setLocalAudioLevel(0);
			return;
		}

		const audioContext = new AudioContext();
		// Resume context if suspended (browser autoplay policy)
		if (audioContext.state === "suspended") {
			audioContext.resume();
		}
		const stream = new MediaStream([track]);
		const source = audioContext.createMediaStreamSource(stream);
		const analyser = audioContext.createAnalyser();
		analyser.fftSize = 256;
		analyser.smoothingTimeConstant = 0.5;
		source.connect(analyser);

		const dataArray = new Uint8Array(analyser.frequencyBinCount);
		let animationId: number;

		const updateLevel = () => {
			// Use frequency data for responsive visual feedback
			analyser.getByteFrequencyData(dataArray);
			// Get peak value from lower frequencies (voice range ~80-1000Hz)
			let peak = 0;
			const voiceRange = Math.min(32, dataArray.length); // Focus on lower frequencies
			for (let i = 0; i < voiceRange; i++) {
				const value = dataArray[i] ?? 0;
				if (value > peak) peak = value;
			}
			// Normalize and apply curve for better visual response
			const normalized = peak / 255;
			setLocalAudioLevel(Math.min(1, normalized * 1.5));
			animationId = requestAnimationFrame(updateLevel);
		};
		updateLevel();

		return () => {
			cancelAnimationFrame(animationId);
			audioContext.close();
		};
	}, [localAudioTrack, isAudioEnabled]);

	// Store refs for cleanup
	const localVideoTrackRef = useRef(localVideoTrack);
	const localAudioTrackRef = useRef(localAudioTrack);
	localVideoTrackRef.current = localVideoTrack;
	localAudioTrackRef.current = localAudioTrack;

	// Cleanup tracks on unmount
	useEffect(() => {
		return () => {
			localVideoTrackRef.current?.stop();
			localAudioTrackRef.current?.stop();
		};
	}, []);

	// Attach video track to video element
	useEffect(() => {
		const videoEl = videoRef.current;
		if (!videoEl) return;

		if (!isVideoEnabled || !activeVideoTrack) {
			videoEl.srcObject = null;
			return;
		}

		const stream = new MediaStream([activeVideoTrack]);
		videoEl.srcObject = stream;
		videoEl.play().catch(() => {});

		return () => {
			videoEl.srcObject = null;
		};
	}, [activeVideoTrack, isVideoEnabled]);

	const toggleTheme = () => {
		const newIsDark = !isDarkMode;
		setIsDarkMode(newIsDark);
		// Sync with document for app-wide theme (when used with ThemeProvider)
		if (typeof document !== "undefined") {
			document.documentElement.classList.remove("light", "dark");
			document.documentElement.classList.add(newIsDark ? "dark" : "light");
		}
	};

	useEffect(() => {
		if (userName && !displayName) setDisplayName(userName);
	}, [userName, displayName]);

	// Close dropdown when clicking outside
	useEffect(() => {
		if (!openDropdown) return;
		const handleClickOutside = (e: MouseEvent) => {
			if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
				setOpenDropdown(null);
			}
		};
		document.addEventListener("mousedown", handleClickOutside);
		return () => document.removeEventListener("mousedown", handleClickOutside);
	}, [openDropdown]);

	const handleJoin = () => {
		if (!displayName.trim()) return;

		onJoin({
			displayName,
			videoEnabled: isVideoEnabled,
			audioEnabled: isAudioEnabled,
			selectedVideoDevice,
			selectedAudioInput,
			selectedAudioOutput,
		});
	};

	const hasVideoDevices = effectiveVideoDevices.length > 0;
	const hasAudioInput = effectiveAudioInputDevices.length > 0;
	const hasAudioOutput = audioOutputDevices.length > 0;

	const toggleVideo = () => setIsVideoEnabled(!isVideoEnabled);
	const toggleAudio = () => setIsAudioEnabled(!isAudioEnabled);
	const toggleSettings = () => setShowSettings(!showSettings);

	// Normalize audio level to 0-100 for the bar width
	const normalizedAudioLevel = Math.min(100, Math.max(0, activeAudioLevel * 100));

	// Generate consistent gradient based on display name (same as VideoTile)
	const participantGradient = useMemo(() => getParticipantGradient(displayName), [displayName]);

	return (
		<div
			ref={containerRef}
			data-chalk
			className={cn(
				"chalk-root min-h-screen flex flex-col overflow-hidden relative",
				isDarkMode && "dark",
				className,
			)}
		>
			{/* Loading Screen Overlay */}
			<div 
				className={cn(
					"absolute inset-0 z-50 transition-all duration-1000 ease-in-out pointer-events-none",
					isLoading ? "opacity-100 pointer-events-auto" : "opacity-0"
				)}
			>
				<LoadingScreen 
					message="Joining room..." 
					className="w-full h-full"
				/>
			</div>

			{/* Main Lobby Content - Fades out and scales down slightly when loading */}
			<div 
				className={cn(
					"flex-1 flex flex-col w-full transition-all duration-700 ease-in-out",
					isLoading ? "opacity-0 scale-95 blur-sm" : "opacity-100 scale-100 blur-0"
				)}
			>
				{/* Settings Modal */}
				{showSettings && (
					<div
						className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/20 backdrop-blur-sm"
					>
						<div 
							className="absolute inset-0" 
							onClick={() => setShowSettings(false)} 
							aria-hidden="true" 
						/>
						<div
							className="rounded-2xl border p-6 w-full max-w-md relative animate-in fade-in zoom-in-95 duration-200 overflow-visible z-10"
							role="dialog"
							aria-modal="true"
							aria-labelledby="settings-title"
							tabIndex={-1}
							onKeyDown={(e) => {
								if (e.key === "Escape") setShowSettings(false);
							}}
							style={{
								background: "var(--chalk-lobby-glass-bg)",
								borderColor: "var(--chalk-lobby-glass-border)",
								backdropFilter: "blur(20px)",
								boxShadow: "var(--chalk-shadow-xl)",
							}}
						>
							<button
								type="button"
								onClick={() => setShowSettings(false)}
								aria-label="Close settings"
								className="absolute top-4 right-4 p-2 hover:bg-black/5 dark:hover:bg-white/10 rounded-full transition-colors text-(--muted-foreground) hover:text-(--foreground) outline-none focus-visible:ring-2 focus-visible:ring-[#1bb6a6]"
							>
								<Cancel01Icon size={20} />
							</button>

							<h2 id="settings-title" className="text-xl font-semibold text-(--foreground) mb-6">
								Settings
							</h2>

							<div className="space-y-4">
								{hasVideoDevices && (
									<DeviceSelector
										type="videoinput"
										label="Camera"
										devices={effectiveVideoDevices}
										selectedDeviceId={selectedVideoDevice}
										onChange={onVideoDeviceChange}
										disabled={isLoading}
									/>
								)}

								{hasAudioInput && (
									<DeviceSelector
										type="audioinput"
										label="Microphone"
										devices={effectiveAudioInputDevices}
										selectedDeviceId={selectedAudioInput}
										onChange={onAudioInputChange}
										audioLevel={isAudioEnabled ? activeAudioLevel : 0}
										disabled={isLoading}
									/>
								)}

								{hasAudioOutput && (
									<DeviceSelector
										type="audiooutput"
										label="Speaker"
										devices={audioOutputDevices}
										selectedDeviceId={selectedAudioOutput}
										onChange={onAudioOutputChange}
										disabled={isLoading}
									/>
								)}
							</div>

							<div className="mt-6 flex justify-end">
								<button
									type="button"
									onClick={() => setShowSettings(false)}
									className="px-5 py-2.5 bg-[#1bb6a6] text-white rounded-full hover:bg-[#19a396] transition-colors font-medium outline-none focus-visible:ring-2 focus-visible:ring-[#1bb6a6] focus-visible:ring-offset-2"
								>
									Done
								</button>
							</div>
						</div>
					</div>
				)}

				{/* Header */}
				<div className="flex justify-between items-center px-6 py-5 w-full max-w-6xl mx-auto">
					<div className="flex items-center gap-3">
						<img
							src="/chalk-logo.svg"
							alt="Chalk"
							className="h-8 w-auto"
							draggable={false}
						/>
						{roomName && (
							<>
								<div className="w-px h-6 bg-border/50 mx-1" />
								<span className="text-sm font-medium text-(--muted-foreground) truncate max-w-[200px]">
									{roomName}
								</span>
							</>
						)}
					</div>

					{/* Theme Toggle */}
					<button
						type="button"
						onClick={toggleTheme}
						title={isDarkMode ? "Switch to light mode" : "Switch to dark mode"}
						className="w-10 h-10 rounded-full flex items-center justify-center transition-all duration-200 hover:bg-black/5 dark:hover:bg-white/10 text-(--foreground)"
					>
						{isDarkMode ? <Sun02Icon size={20} /> : <Moon02Icon size={20} />}
					</button>
				</div>

				{/* Main Content */}
				<div className="flex-1 w-full max-w-6xl mx-auto flex items-center px-6 pb-12">
					<div className="grid w-full grid-cols-1 lg:grid-cols-[minmax(0,1fr)_360px] gap-10 items-center">
						{/* Left Column: Video Preview with Floating Controls */}
						<div className="w-full relative">
							{/* Spatial shadow layers for depth */}
							<div
								className="absolute -inset-1 rounded-3xl opacity-30 blur-xl"
								style={{ background: participantGradient }}
							/>
							<div
								className="absolute -inset-0.5 rounded-2xl opacity-20 blur-md"
								style={{ background: participantGradient }}
							/>

							{/* Main video container */}
							<div
								className="relative w-full aspect-video rounded-2xl overflow-hidden"
								style={{
									background: participantGradient,
									boxShadow:
										"var(--chalk-shadow-lg), inset 0 1px 0 rgba(255,255,255,0.1)",
								}}
							>
								{/* Video element - mirrored for local preview */}
								<video
									ref={videoRef}
									autoPlay
									playsInline
									muted
									className={cn(
										"absolute inset-0 w-full h-full object-cover",
										isVideoEnabled ? "opacity-100" : "opacity-0",
									)}
									style={{ transform: "scaleX(-1)" }}
								/>

								{/* Name Badge with Audio Level - Top Left */}
								<div className="absolute top-4 left-4 z-20">
									<div
										className="flex items-center gap-3 px-3 py-2 rounded-full"
										style={{
											background: "var(--chalk-lobby-glass-bg)",
											borderColor: "var(--chalk-lobby-glass-border)",
											backdropFilter: "blur(16px)",
											border: "1px solid var(--chalk-lobby-glass-border)",
										}}
									>
										{/* Audio status dot */}
										<div
											className={cn(
												"w-2 h-2 rounded-full flex-shrink-0 transition-colors",
												isAudioEnabled
													? "bg-[#1bb6a6] shadow-[0_0_8px_rgba(27,182,166,0.6)]"
													: "bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.6)]",
											)}
										/>
										<span className="text-sm font-medium text-(--foreground)">
											{displayName || "You"}
										</span>

										{/* Horizontal audio level bar */}
										{isAudioEnabled && (
											<div className="w-16 h-1.5 bg-black/20 dark:bg-white/20 rounded-full overflow-hidden">
												<div
													className="h-full bg-[#1bb6a6] rounded-full"
													style={{
														width: `${normalizedAudioLevel}%`,
														transition: "width 50ms ease-out"
													}}
												/>
											</div>
										)}
									</div>
								</div>

								{/* Camera Off State - Center (matches VideoTile) */}
								{!isVideoEnabled && (
									<div className="absolute inset-0 flex items-center justify-center">
										<Avatar
											name={displayName}
											size="2xl"
											className="opacity-90"
										/>
									</div>
								)}

								{/* Floating Control Bar - Bottom Center */}
								<div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-20" ref={dropdownRef}>
									{/* Device Dropdowns - now anchored to the control bar */}
									{openDropdown && (
										<div
											className="absolute bottom-full mb-2 w-64 rounded-xl border border-white/10 shadow-2xl overflow-hidden"
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
												{(openDropdown === "audio" ? effectiveAudioInputDevices : effectiveVideoDevices).map((device) => {
													const isSelected = openDropdown === "audio"
														? selectedAudioInput === device.deviceId
														: selectedVideoDevice === device.deviceId;
													return (
														<button
															type="button"
															key={device.deviceId}
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
																	? "bg-[#1bb6a6]/20 text-[#1bb6a6]"
																	: "text-white/90 hover:bg-white/10",
															)}
														>
															{isSelected && (
																<span className="w-1.5 h-1.5 rounded-full bg-[#1bb6a6] shrink-0" />
															)}
															<span className={cn("truncate", !isSelected && "ml-[18px]")}>
																{device.label || `${openDropdown === "audio" ? "Microphone" : "Camera"} ${device.deviceId.slice(0, 5)}`}
															</span>
														</button>
													);
												})}
											</div>
										</div>
									)}

									<div
										className="flex items-center gap-4 px-3 py-2 rounded-full relative"
										style={{
											background: "var(--chalk-lobby-glass-bg)",
											backdropFilter: "blur(20px)",
											border: "1px solid var(--chalk-lobby-glass-border)",
											boxShadow: "var(--chalk-shadow-md)",
										}}
									>
										{/* Mic toggle with dropdown */}
										<div className="flex items-center gap-1.5">
											<button
												type="button"
												onClick={toggleAudio}
												title={isAudioEnabled ? "Mute microphone" : "Unmute microphone"}
												className={cn(
													"w-11 h-11 rounded-full flex items-center justify-center transition-all duration-200 outline-none focus-visible:ring-2 focus-visible:ring-[#1bb6a6]",
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
													onClick={(e) => {
														e.stopPropagation();
														setOpenDropdown(openDropdown === "audio" ? null : "audio");
													}}
													title="Select microphone"
													aria-label="Select microphone"
													aria-haspopup="true"
													aria-expanded={openDropdown === "audio"}
													className={cn(
														"w-7 h-7 rounded-full flex items-center justify-center transition-all duration-200 outline-none focus-visible:ring-2 focus-visible:ring-[#1bb6a6]",
														openDropdown === "audio"
															? "bg-[#1bb6a6] text-white"
															: "bg-black/5 dark:bg-white/10 text-(--foreground) hover:bg-black/10 dark:hover:bg-white/20",
													)}
												>
													<ArrowDown01Icon size={14} />
												</button>
											)}
										</div>

										{/* Video toggle with dropdown */}
										<div className="flex items-center gap-1.5">
											<button
												type="button"
												onClick={toggleVideo}
												title={isVideoEnabled ? "Turn off camera" : "Turn on camera"}
												className={cn(
													"w-11 h-11 rounded-full flex items-center justify-center transition-all duration-200 outline-none focus-visible:ring-2 focus-visible:ring-[#1bb6a6]",
													!isVideoEnabled
														? "bg-red-500 text-white hover:bg-red-600"
														: "bg-black/5 dark:bg-white/10 text-(--foreground) hover:bg-black/10 dark:hover:bg-white/20",
												)}
											>
												{isVideoEnabled ? (
													<Video01Icon size={20} />
												) : (
													<VideoOffIcon size={20} />
												)}
											</button>
											{hasVideoDevices && (
												<button
													type="button"
													onClick={(e) => {
														e.stopPropagation();
														setOpenDropdown(openDropdown === "video" ? null : "video");
													}}
													title="Select camera"
													aria-label="Select camera"
													aria-haspopup="true"
													aria-expanded={openDropdown === "video"}
													className={cn(
														"w-7 h-7 rounded-full flex items-center justify-center transition-all duration-200 outline-none focus-visible:ring-2 focus-visible:ring-[#1bb6a6]",
														openDropdown === "video"
															? "bg-[#1bb6a6] text-white"
															: "bg-black/5 dark:bg-white/10 text-(--foreground) hover:bg-black/10 dark:hover:bg-white/20",
													)}
												>
													<ArrowDown01Icon size={14} />
												</button>
											)}
										</div>

										{/* Divider */}
										<div className="w-px h-6 bg-black/10 dark:bg-white/20 mx-1" />

										{/* Settings */}
										<button
											type="button"
											onClick={toggleSettings}
											title="Settings"
											className="w-11 h-11 rounded-full flex items-center justify-center bg-black/5 dark:bg-white/10 text-(--foreground) hover:bg-black/10 dark:hover:bg-white/20 transition-all duration-200 outline-none focus-visible:ring-2 focus-visible:ring-[#1bb6a6]"
										>
											<MoreVerticalIcon size={18} />
										</button>
									</div>
								</div>
							</div>
						</div>

						{/* Right Column: Join Form */}
						<div className="flex flex-col items-start text-left space-y-6 w-full max-w-sm lg:justify-self-end">
							<div className="space-y-2 text-left">
								<h1 className="text-3xl lg:text-4xl font-semibold tracking-tight text-(--foreground)">
									Ready to join?
								</h1>
								<p className="text-(--muted-foreground) text-base">
									You'll be in a waiting room before entering the call
								</p>
							</div>

							<div className="w-full space-y-4">
								{/* Name input with glass effect */}
								<div className="w-full">
									<label htmlFor="display-name" className="sr-only">
										Display Name
									</label>
									<input
										id="display-name"
										type="text"
										value={displayName}
										onChange={(e) => setDisplayName(e.target.value)}
										placeholder="Enter your name"
										disabled={isLoading}
										className={cn(
											"w-full h-12 px-4 rounded-xl text-base transition-all outline-none text-(--foreground) placeholder:text-(--muted-foreground) disabled:opacity-50",
											"border bg-[var(--chalk-lobby-glass-bg)] backdrop-blur-md",
											"border-[var(--chalk-lobby-glass-border)]",
											"focus-visible:border-[#1bb6a6] focus-visible:ring-4 focus-visible:ring-[#1bb6a6]/15"
										)}
									/>
								</div>

								{/* Join button with gradient and shimmer */}
								<button
									type="button"
									onClick={handleJoin}
									disabled={!displayName.trim() || isLoading}
									className={cn(
										"relative w-full h-12 rounded-full font-semibold text-base text-white transition-all active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 overflow-hidden group",
										"outline-none focus-visible:ring-4 focus-visible:ring-[#1bb6a6]/30"
									)}
									style={{
										background:
											"linear-gradient(135deg, #1bb6a6 0%, #14a89a 50%, #0d9488 100%)",
										boxShadow:
											"0 4px 14px rgba(27, 182, 166, 0.4), inset 0 1px 0 rgba(255,255,255,0.2)",
									}}
								>
									{/* Shimmer overlay */}
									<div
										className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-300"
										style={{
											background:
												"linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.3) 50%, transparent 100%)",
											backgroundSize: "200% 100%",
											animation: "chalk-shimmer 1.5s ease-in-out infinite",
										}}
									/>
									<span className="relative z-10 flex items-center gap-2">
										{isLoading ? "Joining..." : "Ask to join"}
									</span>
								</button>
							</div>
						</div>
					</div>
				</div>

				{/* Error Toast */}
				{error && (
					<div className="fixed bottom-6 left-1/2 -translate-x-1/2 w-full max-w-md z-50">
						<Toast
							type="error"
							message={error}
							onDismiss={() => {}}
							duration={0}
						/>
					</div>
				)}
			</div>
		</div>
	);
}

export const PreJoinLobby = memo(PreJoinLobbyBase);
PreJoinLobby.displayName = "PreJoinLobby";
