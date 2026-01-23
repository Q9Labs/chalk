import {
	Microphone01Icon,
	MicrophoneOff01Icon,
	MoreVerticalIcon,
	Video01Icon,
	VideoOffIcon,
	Cancel01Icon,
	Sun02Icon,
	Moon02Icon,
} from "../../utils/icons";
import { memo, useEffect, useRef, useState } from "react";
import { cn } from "../../utils/cn";
import { Avatar, Toast } from "../atomic";
import { DeviceSelector } from "../composite";
import { LoadingScreen } from "./LoadingScreen";

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
	roomName: _roomName,
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
	const videoRef = useRef<HTMLVideoElement>(null);
	const containerRef = useRef<HTMLDivElement>(null);

	// Local media state (used when no external track is provided)
	const [localVideoTrack, setLocalVideoTrack] =
		useState<MediaStreamTrack | null>(null);
	const [localAudioTrack, setLocalAudioTrack] =
		useState<MediaStreamTrack | null>(null);
	const [localAudioLevel, setLocalAudioLevel] = useState(0);

	// Use provided track or local track
	const activeVideoTrack = videoTrack ?? localVideoTrack;
	const activeAudioLevel = audioLevel || localAudioLevel;

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
					stream.getTracks().forEach((t) => t.stop());
					return;
				}
				const track = stream.getVideoTracks()[0];
				if (track) setLocalVideoTrack(track);
			})
			.catch(() => {
				// Permission denied or error - just disable video
				if (!cancelled) setIsVideoEnabled(false);
			});

		return () => {
			cancelled = true;
		};
	}, [isVideoEnabled, videoTrack, selectedVideoDevice]);

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
					stream.getTracks().forEach((t) => t.stop());
					return;
				}
				const track = stream.getAudioTracks()[0];
				if (track) setLocalAudioTrack(track);
			})
			.catch(() => {
				if (!cancelled) setIsAudioEnabled(false);
			});

		return () => {
			cancelled = true;
		};
	}, [isAudioEnabled, selectedAudioInput]);

	// Audio level monitoring
	useEffect(() => {
		const track = localAudioTrack;
		if (!track || !isAudioEnabled) {
			setLocalAudioLevel(0);
			return;
		}

		const audioContext = new AudioContext();
		const stream = new MediaStream([track]);
		const source = audioContext.createMediaStreamSource(stream);
		const analyser = audioContext.createAnalyser();
		analyser.fftSize = 256;
		source.connect(analyser);

		const dataArray = new Uint8Array(analyser.frequencyBinCount);
		let animationId: number;

		const updateLevel = () => {
			analyser.getByteFrequencyData(dataArray);
			const average = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
			setLocalAudioLevel(average / 255);
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
	}, [userName]);

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

	const hasVideoDevices = videoDevices.length > 0;
	const hasAudioInput = audioInputDevices.length > 0;
	const hasAudioOutput = audioOutputDevices.length > 0;

	const toggleVideo = () => setIsVideoEnabled(!isVideoEnabled);
	const toggleAudio = () => setIsAudioEnabled(!isAudioEnabled);
	const toggleSettings = () => setShowSettings(!showSettings);

	// Normalize audio level to 0-100 for the bar width
	const normalizedAudioLevel = Math.min(100, Math.max(0, activeAudioLevel * 100));

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
					"absolute inset-0 z-50 transition-all duration-700 ease-in-out pointer-events-none",
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
					<div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/20 backdrop-blur-sm">
						<div
							className="rounded-2xl border p-6 w-full max-w-md relative animate-in fade-in zoom-in-95 duration-200"
							style={{
								background: "var(--chalk-lobby-glass-bg)",
								borderColor: "var(--chalk-lobby-glass-border)",
								backdropFilter: "blur(20px)",
								boxShadow: "var(--chalk-shadow-xl)",
							}}
						>
							<button
								onClick={() => setShowSettings(false)}
								className="absolute top-4 right-4 p-2 hover:bg-black/5 dark:hover:bg-white/10 rounded-full transition-colors text-(--muted-foreground) hover:text-(--foreground)"
							>
								<Cancel01Icon size={20} />
							</button>

							<h2 className="text-xl font-semibold text-(--foreground) mb-6">
								Settings
							</h2>

							<div className="space-y-4">
								{hasVideoDevices && (
									<DeviceSelector
										type="videoinput"
										label="Camera"
										devices={videoDevices}
										selectedDeviceId={selectedVideoDevice}
										onChange={onVideoDeviceChange}
										disabled={isLoading || !isVideoEnabled}
									/>
								)}

								{hasAudioInput && (
									<DeviceSelector
										type="audioinput"
										label="Microphone"
										devices={audioInputDevices}
										selectedDeviceId={selectedAudioInput}
										onChange={onAudioInputChange}
										audioLevel={isAudioEnabled ? audioLevel : 0}
										disabled={isLoading || !isAudioEnabled}
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
									onClick={() => setShowSettings(false)}
									className="px-5 py-2.5 bg-[#1bb6a6] text-white rounded-full hover:bg-[#19a396] transition-colors font-medium"
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
					</div>

					{/* Theme Toggle */}
					<button
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
								style={{ background: "var(--chalk-lobby-gradient)" }}
							/>
							<div
								className="absolute -inset-0.5 rounded-2xl opacity-20 blur-md"
								style={{ background: "var(--chalk-lobby-gradient)" }}
							/>

							{/* Main video container */}
							<div
								className="relative w-full aspect-video rounded-2xl overflow-hidden border-2 border-white/20 dark:border-white/10"
								style={{
									background: "var(--chalk-lobby-gradient)",
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
											<div className="w-16 h-1.5 bg-black/10 dark:bg-white/10 rounded-full overflow-hidden">
												<div
													className="h-full bg-[#1bb6a6] rounded-full transition-all duration-75"
													style={{ width: `${normalizedAudioLevel}%` }}
												/>
											</div>
										)}
									</div>
								</div>

								{/* Camera Off State - Center */}
								{!isVideoEnabled && (
									<div className="absolute inset-0 flex flex-col items-center justify-center z-10">
										{/* Avatar with glow ring */}
										<div className="relative">
											{/* Outer glow ring */}
											<div
												className="absolute -inset-3 rounded-full chalk-animate-glow-pulse"
												style={{
													background:
														"radial-gradient(circle, var(--chalk-lobby-avatar-glow) 0%, transparent 70%)",
												}}
											/>
											{/* Avatar container with border */}
											<div
												className="relative rounded-full p-1"
												style={{
													background:
														"linear-gradient(135deg, rgba(27,182,166,0.3) 0%, rgba(27,182,166,0.1) 100%)",
												}}
											>
												<Avatar
													name={displayName}
													size="2xl"
													className="w-28! h-28! text-4xl"
												/>
											</div>
										</div>
									</div>
								)}

								{/* Floating Control Bar - Bottom Center */}
								<div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-20">
									<div
										className="flex items-center gap-2 px-2 py-2 rounded-full"
										style={{
											background: "var(--chalk-lobby-glass-bg)",
											backdropFilter: "blur(20px)",
											border: "1px solid var(--chalk-lobby-glass-border)",
											boxShadow: "var(--chalk-shadow-md)",
										}}
									>
										{/* Mic toggle */}
										<button
											onClick={toggleAudio}
											title={isAudioEnabled ? "Mute microphone" : "Unmute microphone"}
											className={cn(
												"w-11 h-11 rounded-full flex items-center justify-center transition-all duration-200",
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

										{/* Video toggle */}
										<button
											onClick={toggleVideo}
											title={isVideoEnabled ? "Turn off camera" : "Turn on camera"}
											className={cn(
												"w-11 h-11 rounded-full flex items-center justify-center transition-all duration-200",
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

										{/* Divider */}
										<div className="w-px h-6 bg-black/10 dark:bg-white/20 mx-1" />

										{/* Settings */}
										<button
											onClick={toggleSettings}
											title="Settings"
											className="w-11 h-11 rounded-full flex items-center justify-center bg-black/5 dark:bg-white/10 text-(--foreground) hover:bg-black/10 dark:hover:bg-white/20 transition-all duration-200"
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
										className="w-full h-12 px-4 rounded-xl text-base transition-all outline-none text-(--foreground) placeholder:text-(--muted-foreground) disabled:opacity-50"
										style={{
											background: "var(--chalk-lobby-glass-bg)",
											border: "1px solid var(--chalk-lobby-glass-border)",
											backdropFilter: "blur(12px)",
										}}
										onFocus={(e) => {
											e.target.style.borderColor = "#1bb6a6";
											e.target.style.boxShadow =
												"0 0 0 3px rgba(27, 182, 166, 0.15)";
										}}
										onBlur={(e) => {
											e.target.style.borderColor =
												"var(--chalk-lobby-glass-border)";
											e.target.style.boxShadow = "none";
										}}
									/>
								</div>

								{/* Join button with gradient and shimmer */}
								<button
									onClick={handleJoin}
									disabled={!displayName.trim() || isLoading}
									className="relative w-full h-12 rounded-full font-semibold text-base text-white transition-all active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 overflow-hidden group"
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
