import { type JoinSettings, PreJoinLobby, useChalk } from "@q9labs/chalk-react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";

const lobbySearchSchema = z.object({
	roomId: z.string(),
});

export const Route = createFileRoute("/room/lobby")({
	validateSearch: lobbySearchSchema,
	component: RoomLobbyPage,
});

function RoomLobbyPage() {
	const navigate = useNavigate();
	const { roomId } = Route.useSearch();
	const { joinRoom } = useChalk();

	// Local State
	const [isJoining, setIsJoining] = useState(false);

	// CRITICAL: Initialize with empty string for SSR, then hydrate from sessionStorage
	const [storedUserName, setStoredUserName] = useState<string>("");

	// CRITICAL: Load from sessionStorage AFTER mount to prevent hydration mismatch
	useEffect(() => {
		const savedName = sessionStorage.getItem("chalk_display_name");
		if (savedName) {
			setStoredUserName(savedName);
		}
	}, []);

	// CRITICAL: Use ref with timestamp to prevent race conditions on rapid retries
	const joinAttempted = useRef<{ timestamp: number; attemptId: string } | null>(
		null,
	);

	// Local Preview Tracks & Devices for Lobby
	const [previewVideoTrack, setPreviewVideoTrack] =
		useState<MediaStreamTrack | null>(null);
	const [previewAudioTrack, setPreviewAudioTrack] =
		useState<MediaStreamTrack | null>(null);

	const [videoDevices, setVideoDevices] = useState<MediaDeviceInfo[]>([]);
	const [audioInputDevices, setAudioInputDevices] = useState<MediaDeviceInfo[]>(
		[],
	);
	const [audioOutputDevices, setAudioOutputDevices] = useState<
		MediaDeviceInfo[]
	>([]);

	const [selectedVideoDevice, setSelectedVideoDevice] = useState<string>("");
	const [selectedAudioInput, setSelectedAudioInput] = useState<string>("");
	const [selectedAudioOutput, setSelectedAudioOutput] = useState<string>("");

	// Track refs to handle cleanup without race conditions
	const previewStreamRef = useRef<MediaStream | null>(null);

	// Load Devices
	useEffect(() => {
		const loadDevices = async () => {
			try {
				// Request permissions first to ensure we get labels
				const stream = await navigator.mediaDevices.getUserMedia({
					video: true,
					audio: true,
				});
				stream.getTracks().forEach((t) => t.stop());

				const devices = await navigator.mediaDevices.enumerateDevices();
				setVideoDevices(devices.filter((d) => d.kind === "videoinput"));
				setAudioInputDevices(devices.filter((d) => d.kind === "audioinput"));
				setAudioOutputDevices(devices.filter((d) => d.kind === "audiooutput"));

				if (!selectedVideoDevice) {
					const vid = devices.find((d) => d.kind === "videoinput");
					if (vid) setSelectedVideoDevice(vid.deviceId);
				}
				if (!selectedAudioInput) {
					const mic = devices.find((d) => d.kind === "audioinput");
					if (mic) setSelectedAudioInput(mic.deviceId);
				}
				if (!selectedAudioOutput) {
					const spk = devices.find((d) => d.kind === "audiooutput");
					if (spk) setSelectedAudioOutput(spk.deviceId);
				}
			} catch (e) {
				console.error("Failed to load devices", e);
			}
		};
		loadDevices();

		// Listen for device changes
		const handleDeviceChange = () => loadDevices();
		navigator.mediaDevices.addEventListener("devicechange", handleDeviceChange);
		return () => {
			navigator.mediaDevices.removeEventListener(
				"devicechange",
				handleDeviceChange,
			);
		};
	}, []);

	// Initialize Preview Stream for Lobby
	useEffect(() => {
		let mounted = true;
		let currentStream: MediaStream | null = null;

		const startPreview = async () => {
			try {
				// Stop any existing preview before starting new one
				const oldStream = previewStreamRef.current;
				if (oldStream) {
					oldStream.getTracks().forEach((t) => t.stop());
					previewStreamRef.current = null;
					// Clear state immediately to prevent stale track usage
					setPreviewVideoTrack(null);
					setPreviewAudioTrack(null);
				}

				const stream = await navigator.mediaDevices.getUserMedia({
					video: selectedVideoDevice
						? { deviceId: { exact: selectedVideoDevice } }
						: true,
					audio: selectedAudioInput
						? { deviceId: { exact: selectedAudioInput } }
						: true,
				});

				if (mounted) {
					currentStream = stream;
					previewStreamRef.current = stream;

					const videoTrack = stream.getVideoTracks()[0] || null;
					const audioTrack = stream.getAudioTracks()[0] || null;

					setPreviewVideoTrack(videoTrack);
					setPreviewAudioTrack(audioTrack);
				} else {
					// Component unmounted during async operation
					stream.getTracks().forEach((t) => t.stop());
				}
			} catch (err) {
				console.error("Failed to get local stream", err);
				if (mounted) {
					setPreviewVideoTrack(null);
					setPreviewAudioTrack(null);
				}
			}
		};

		if (selectedVideoDevice || selectedAudioInput) {
			startPreview();
		}

		return () => {
			mounted = false;
			// Cleanup on unmount or dependency change
			if (currentStream) {
				currentStream.getTracks().forEach((t) => t.stop());
			}
		};
	}, [selectedVideoDevice, selectedAudioInput]);

	// Clean up preview on unmount
	useEffect(() => {
		return () => {
			const stream = previewStreamRef.current;
			if (stream) {
				stream.getTracks().forEach((t) => t.stop());
			}
		};
	}, []);

	// CRITICAL: Handle join with proper sequencing and race condition prevention
	const handleJoinRoom = useCallback(
		async (settings: JoinSettings) => {
			// Generate unique attempt ID to prevent race conditions
			const attemptId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
			const now = Date.now();

			// Prevent rapid retries (less than 2 seconds apart)
			if (
				joinAttempted.current &&
				now - joinAttempted.current.timestamp < 2000
			) {
				console.warn(
					"[Chalk] Join attempt too soon after previous attempt, ignoring",
				);
				return;
			}

			joinAttempted.current = { timestamp: now, attemptId };
			setIsJoining(true);

			try {
				// CRITICAL: Store in sessionStorage ONLY in browser
				if (typeof window !== "undefined") {
					sessionStorage.setItem("chalk_display_name", settings.displayName);
					// Clear stale tokens before join - fresh tokens will be stored after successful join
					sessionStorage.removeItem("chalk_refresh_token");
					sessionStorage.removeItem("chalk_access_token");
				}

				// Stop preview tracks BEFORE joining to ensure media devices are released
				const stream = previewStreamRef.current;
				if (stream) {
					console.log("Stopping preview tracks before join...");
					stream.getTracks().forEach((t) => {
						t.stop();
						console.log("Stopped track:", t.kind, t.id);
					});
					previewStreamRef.current = null;
				}

				// Clear preview state immediately
				setPreviewVideoTrack(null);
				setPreviewAudioTrack(null);

				// CRITICAL: Wait for media devices to be fully released
				await new Promise((resolve) => setTimeout(resolve, 200));

				// Join with media enabled directly to avoid multiple state changes
				const room = await joinRoom(roomId, {
					displayName: settings.displayName,
					video: settings.videoEnabled,
					audio: settings.audioEnabled,
				});

				// Store refresh token for auto-refresh
				if (room.tokens?.refreshToken) {
					sessionStorage.setItem("chalk_refresh_token", room.tokens.refreshToken);
				}
				if (room.tokens?.accessToken) {
					sessionStorage.setItem("chalk_access_token", room.tokens.accessToken);
				}

				// If specific devices were selected, switch to them after joining
				if (settings.videoEnabled && settings.selectedVideoDevice) {
					// Give RTK a moment to stabilize after join
					await new Promise((resolve) => setTimeout(resolve, 300));
					try {
						await room.selectCamera(settings.selectedVideoDevice);
					} catch (e) {
						console.warn("Failed to select camera, using default:", e);
					}
				}

				if (settings.audioEnabled && settings.selectedAudioInput) {
					try {
						await room.selectMicrophone(settings.selectedAudioInput);
					} catch (e) {
						console.warn("Failed to select microphone, using default:", e);
					}
				}

				// SUCCESS: Navigate to the room
				navigate({ to: "/room/$roomId", params: { roomId } });
			} catch (err) {
				console.error("Failed to join:", err);
				const errorMessage =
					err instanceof Error ? err.message : "Unknown error";

				// Map error messages to user-friendly ones
				let userMessage = errorMessage;
				if (
					errorMessage.includes("Network error") ||
					errorMessage.includes("connection attempt failed")
				) {
					userMessage =
						"Network error. Please check your connection and wait a moment before retrying.";
				} else if (
					errorMessage.includes("403") ||
					errorMessage.includes("Forbidden")
				) {
					userMessage =
						"API demo mode is disabled. Set CHALK_ENABLE_DEMO=true in apps/api/.env and restart the API server.";
				} else if (
					errorMessage.includes("fetch") ||
					errorMessage.includes("network")
				) {
					userMessage =
						"Cannot connect to API server. Make sure the API is running on http://localhost:8080";
				}

				// Navigate to error page with error details
				navigate({
					to: "/room/error",
					search: { message: userMessage, roomId },
				});

				// Only allow retry after 3 seconds for network-related errors
				setTimeout(() => {
					joinAttempted.current = null;
				}, 3000);
			} finally {
				setIsJoining(false);
			}
		},
		[joinRoom, roomId, navigate],
	);

	const handleCancel = useCallback(() => {
		// Clean up preview before leaving
		const stream = previewStreamRef.current;
		if (stream) {
			stream.getTracks().forEach((t) => t.stop());
			previewStreamRef.current = null;
		}
		navigate({ to: "/" });
	}, [navigate]);

	return (
		<PreJoinLobby
			roomName={roomId}
			userName={storedUserName}
			onJoin={handleJoinRoom}
			onCancel={handleCancel}
			videoTrack={previewVideoTrack}
			audioTrack={previewAudioTrack}
			videoDevices={videoDevices}
			audioInputDevices={audioInputDevices}
			audioOutputDevices={audioOutputDevices}
			selectedVideoDevice={selectedVideoDevice}
			selectedAudioInput={selectedAudioInput}
			selectedAudioOutput={selectedAudioOutput}
			onVideoDeviceChange={setSelectedVideoDevice}
			onAudioInputChange={setSelectedAudioInput}
			onAudioOutputChange={setSelectedAudioOutput}
			isLoading={isJoining}
			initialVideoEnabled={false}
			initialAudioEnabled={false}
		/>
	);
}

export default RoomLobbyPage;
