import { createLogger } from "@q9labs/chalk-core";
import { useCallback, useEffect, useState } from "react";
import {
	Alert,
	Linking,
	NativeModules,
	PermissionsAndroid,
	Platform,
} from "react-native";

const log = createLogger("usePermissions");

/**
 * Get the PermissionsModule from NativeModules at runtime
 * Must be accessed dynamically because NativeModules is a Proxy
 */
function getPermissionsModule() {
	return NativeModules.PermissionsModule;
}

/**
 * Permission status for each permission type
 */
export type PermissionStatus =
	| "granted"
	| "denied"
	| "blocked"
	| "unavailable"
	| "limited";

/**
 * State of all required permissions
 */
export interface PermissionsState {
	camera: PermissionStatus;
	microphone: PermissionStatus;
	notifications: PermissionStatus;
	bluetooth: PermissionStatus;
}

/**
 * Result of the usePermissions hook
 */
export interface UsePermissionsResult {
	/** Current state of all permissions */
	permissions: PermissionsState;
	/** Whether permissions are currently being checked */
	isChecking: boolean;
	/** Whether all required permissions (camera + mic) are granted */
	hasRequiredPermissions: boolean;
	/** Check current permission status without requesting */
	checkPermissions: () => Promise<PermissionsState>;
	/** Request camera and microphone permissions */
	requestPermissions: () => Promise<boolean>;
	/** Request notification permission (Android 13+) */
	requestNotificationPermission: () => Promise<boolean>;
	/** Open device settings to manually enable permissions */
	openSettings: () => Promise<void>;
	/** Show alert with option to open settings */
	showPermissionDeniedAlert: (
		missingPermissions: ("camera" | "microphone")[],
	) => void;
}

const initialState: PermissionsState = {
	camera: "unavailable",
	microphone: "unavailable",
	notifications: "unavailable",
	bluetooth: "unavailable",
};

/**
 * Convert Android PermissionsAndroid result to PermissionStatus
 */
function androidResultToStatus(
	result: (typeof PermissionsAndroid.RESULTS)[keyof typeof PermissionsAndroid.RESULTS],
): PermissionStatus {
	switch (result) {
		case PermissionsAndroid.RESULTS.GRANTED:
			return "granted";
		case PermissionsAndroid.RESULTS.DENIED:
			return "denied";
		case PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN:
			return "blocked";
		default:
			return "unavailable";
	}
}

/**
 * Hook for managing camera, microphone, and notification permissions
 * on React Native iOS and Android.
 *
 * @example
 * ```tsx
 * function PreCallScreen() {
 *   const {
 *     permissions,
 *     hasRequiredPermissions,
 *     requestPermissions,
 *     openSettings,
 *   } = usePermissions();
 *
 *   useEffect(() => {
 *     if (!hasRequiredPermissions) {
 *       requestPermissions();
 *     }
 *   }, [hasRequiredPermissions, requestPermissions]);
 *
 *   if (!hasRequiredPermissions) {
 *     return (
 *       <View>
 *         <Text>Camera and microphone access required</Text>
 *         <Button title="Grant Permissions" onPress={requestPermissions} />
 *         {permissions.camera === 'blocked' && (
 *           <Button title="Open Settings" onPress={openSettings} />
 *         )}
 *       </View>
 *     );
 *   }
 *
 *   return <CallScreen />;
 * }
 * ```
 */
export function usePermissions(): UsePermissionsResult {
	const [permissions, setPermissions] =
		useState<PermissionsState>(initialState);
	const [isChecking, setIsChecking] = useState(true);

	const hasRequiredPermissions =
		permissions.camera === "granted" && permissions.microphone === "granted";

	/**
	 * Check current permission status without requesting
	 */
	const checkPermissions = useCallback(async (): Promise<PermissionsState> => {
		setIsChecking(true);

		try {
			if (Platform.OS === "android") {
				const [camera, microphone, notifications, bluetooth] =
					await Promise.all([
						PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.CAMERA),
						PermissionsAndroid.check(
							PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
						),
						// POST_NOTIFICATIONS only exists on Android 13+
						Platform.Version >= 33
							? PermissionsAndroid.check(
									"android.permission.POST_NOTIFICATIONS" as (typeof PermissionsAndroid.PERMISSIONS)[keyof typeof PermissionsAndroid.PERMISSIONS],
								)
							: Promise.resolve(true),
						PermissionsAndroid.check(
							PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
						).catch(() => false),
					]);

				const state: PermissionsState = {
					camera: camera ? "granted" : "denied",
					microphone: microphone ? "granted" : "denied",
					notifications: notifications ? "granted" : "denied",
					bluetooth: bluetooth ? "granted" : "unavailable",
				};

				setPermissions(state);
				return state;
			}

			// iOS: Use native module to check AVFoundation permissions
			const PermissionsModule = getPermissionsModule();
			log.debug("Checking iOS permissions, module available:", !!PermissionsModule);
			if (PermissionsModule?.checkPermissions) {
				try {
					const result = await PermissionsModule.checkPermissions();
					log.debug("iOS permission result:", result);

					const state: PermissionsState = {
						camera: result.camera as PermissionStatus,
						microphone: result.microphone as PermissionStatus,
						notifications: "granted", // iOS notifications handled separately
						bluetooth: "unavailable",
					};

					setPermissions(state);
					return state;
				} catch (error) {
					log.error("iOS permission check failed", error);
				}
			}

			// Fallback: return initial state (unavailable)
			return initialState;
		} finally {
			setIsChecking(false);
		}
	}, []); // No dependencies - check permissions once on mount

	/**
	 * Request camera and microphone permissions
	 */
	const requestPermissions = useCallback(async (): Promise<boolean> => {
		if (Platform.OS === "android") {
			try {
				const results = await PermissionsAndroid.requestMultiple([
					PermissionsAndroid.PERMISSIONS.CAMERA,
					PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
				]);

				const cameraStatus = androidResultToStatus(
					results[PermissionsAndroid.PERMISSIONS.CAMERA],
				);
				const micStatus = androidResultToStatus(
					results[PermissionsAndroid.PERMISSIONS.RECORD_AUDIO],
				);

				setPermissions((prev) => ({
					...prev,
					camera: cameraStatus,
					microphone: micStatus,
				}));

				return cameraStatus === "granted" && micStatus === "granted";
			} catch (error) {
				log.error("Request failed", error);
				return false;
			}
		}

		// iOS: Request permissions via native module
		const PermissionsModule = getPermissionsModule();
		if (PermissionsModule?.requestCameraPermission) {
			try {
				const [cameraStatus, micStatus] = await Promise.all([
					PermissionsModule.requestCameraPermission(),
					PermissionsModule.requestMicrophonePermission(),
				]);

				setPermissions((prev) => ({
					...prev,
					camera: cameraStatus as PermissionStatus,
					microphone: micStatus as PermissionStatus,
				}));

				return cameraStatus === "granted" && micStatus === "granted";
			} catch (error) {
				log.error("iOS permission request failed", error);
				return false;
			}
		}

		// Fallback: assume permissions will be requested by WebRTC
		setPermissions((prev) => ({
			...prev,
			camera: "granted",
			microphone: "granted",
		}));
		return true;
	}, []);

	/**
	 * Request notification permission (Android 13+)
	 */
	const requestNotificationPermission =
		useCallback(async (): Promise<boolean> => {
			if (Platform.OS !== "android" || Platform.Version < 33) {
				// Notifications don't require runtime permission before Android 13
				setPermissions((prev) => ({ ...prev, notifications: "granted" }));
				return true;
			}

			try {
				const result = await PermissionsAndroid.request(
					"android.permission.POST_NOTIFICATIONS" as (typeof PermissionsAndroid.PERMISSIONS)[keyof typeof PermissionsAndroid.PERMISSIONS],
				);

				const status = androidResultToStatus(result);
				setPermissions((prev) => ({ ...prev, notifications: status }));
				return status === "granted";
			} catch (error) {
				log.error("Notification permission request failed", error);
				return false;
			}
		}, []);

	/**
	 * Open device settings
	 */
	const openSettings = useCallback(async (): Promise<void> => {
		try {
			await Linking.openSettings();
		} catch (error) {
			log.error("Failed to open settings", error);
		}
	}, []);

	/**
	 * Show alert when permissions are denied
	 */
	const showPermissionDeniedAlert = useCallback(
		(missingPermissions: ("camera" | "microphone")[]) => {
			const names = missingPermissions.map((p) =>
				p === "camera" ? "Camera" : "Microphone",
			);
			const isBlocked = missingPermissions.some(
				(p) => permissions[p] === "blocked",
			);

			Alert.alert(
				"Permissions Required",
				`Chalk needs ${names.join(" and ")} access to make video calls.${
					isBlocked ? " Please enable in Settings." : ""
				}`,
				[
					{ text: "Cancel", style: "cancel" },
					...(isBlocked
						? [{ text: "Open Settings", onPress: openSettings }]
						: [{ text: "Try Again", onPress: requestPermissions }]),
				],
			);
		},
		[permissions, openSettings, requestPermissions],
	);

	// Check permissions on mount
	useEffect(() => {
		checkPermissions();
	}, [checkPermissions]);

	return {
		permissions,
		isChecking,
		hasRequiredPermissions,
		checkPermissions,
		requestPermissions,
		requestNotificationPermission,
		openSettings,
		showPermissionDeniedAlert,
	};
}
