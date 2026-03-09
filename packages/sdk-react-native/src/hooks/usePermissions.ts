import { useCallback, useEffect, useState } from "react";
import { Alert, Linking, NativeModules, PermissionsAndroid, Platform } from "react-native";
import { logger } from "../logger";

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
export type PermissionStatus = "granted" | "denied" | "blocked" | "unavailable" | "limited";

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
  showPermissionDeniedAlert: (missingPermissions: ("camera" | "microphone")[]) => void;
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
function androidResultToStatus(result: (typeof PermissionsAndroid.RESULTS)[keyof typeof PermissionsAndroid.RESULTS]): PermissionStatus {
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
  const [permissions, setPermissions] = useState<PermissionsState>(initialState);
  const [isChecking, setIsChecking] = useState(true);

  const hasRequiredPermissions = permissions.camera === "granted" && permissions.microphone === "granted";

  /**
   * Check current permission status without requesting
   */
  const checkPermissions = useCallback(async (): Promise<PermissionsState> => {
    setIsChecking(true);

    logger.info({
      event: "permissions.check",
      platform: Platform.OS,
    });

    try {
      if (Platform.OS === "android") {
        const [camera, microphone, notifications, bluetooth] = await Promise.all([
          PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.CAMERA),
          PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO),
          // POST_NOTIFICATIONS only exists on Android 13+
          Platform.Version >= 33 ? PermissionsAndroid.check("android.permission.POST_NOTIFICATIONS" as (typeof PermissionsAndroid.PERMISSIONS)[keyof typeof PermissionsAndroid.PERMISSIONS]) : Promise.resolve(true),
          PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT).catch(() => false),
        ]);

        const state: PermissionsState = {
          camera: camera ? "granted" : "denied",
          microphone: microphone ? "granted" : "denied",
          notifications: notifications ? "granted" : "denied",
          bluetooth: bluetooth ? "granted" : "unavailable",
        };

        logger.info({
          event: "permissions.status",
          platform: "android",
          permissions: state,
        });

        setPermissions(state);
        return state;
      }

      // iOS: Use native module to check AVFoundation permissions
      const PermissionsModule = getPermissionsModule();
      if (PermissionsModule?.checkPermissions) {
        try {
          const result = await PermissionsModule.checkPermissions();

          const state: PermissionsState = {
            camera: result.camera as PermissionStatus,
            microphone: result.microphone as PermissionStatus,
            notifications: "granted", // iOS notifications handled separately
            bluetooth: "unavailable",
          };

          logger.info({
            event: "permissions.status",
            platform: "ios",
            permissions: state,
          });

          setPermissions(state);
          return state;
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          logger.error({
            event: "permissions.check.error",
            platform: "ios",
            outcome: "error",
            error: { message: error.message, type: error.name },
          });
        }
      }

      // Fallback: return initial state (unavailable)
      logger.info({
        event: "permissions.status",
        platform: Platform.OS,
        permissions: initialState,
        note: "fallback_unavailable",
      });
      return initialState;
    } finally {
      setIsChecking(false);
    }
  }, []); // No dependencies - check permissions once on mount

  /**
   * Request camera and microphone permissions
   */
  const requestPermissions = useCallback(async (): Promise<boolean> => {
    logger.info({
      event: "permissions.request",
      platform: Platform.OS,
      requested: ["camera", "microphone"],
    });

    if (Platform.OS === "android") {
      try {
        const results = await PermissionsAndroid.requestMultiple([PermissionsAndroid.PERMISSIONS.CAMERA, PermissionsAndroid.PERMISSIONS.RECORD_AUDIO]);

        const cameraStatus = androidResultToStatus(results[PermissionsAndroid.PERMISSIONS.CAMERA]);
        const micStatus = androidResultToStatus(results[PermissionsAndroid.PERMISSIONS.RECORD_AUDIO]);

        const allGranted = cameraStatus === "granted" && micStatus === "granted";

        logger.info({
          event: "permissions.result",
          platform: "android",
          outcome: allGranted ? "success" : "denied",
          permissions: {
            camera: cameraStatus,
            microphone: micStatus,
          },
        });

        setPermissions((prev) => ({
          ...prev,
          camera: cameraStatus,
          microphone: micStatus,
        }));

        return allGranted;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        logger.error({
          event: "permissions.request.error",
          platform: "android",
          outcome: "error",
          error: { message: error.message, type: error.name },
        });
        return false;
      }
    }

    // iOS: Request permissions via native module
    const PermissionsModule = getPermissionsModule();
    if (PermissionsModule?.requestCameraPermission) {
      try {
        const [cameraStatus, micStatus] = await Promise.all([PermissionsModule.requestCameraPermission(), PermissionsModule.requestMicrophonePermission()]);

        const allGranted = cameraStatus === "granted" && micStatus === "granted";

        logger.info({
          event: "permissions.result",
          platform: "ios",
          outcome: allGranted ? "success" : "denied",
          permissions: {
            camera: cameraStatus,
            microphone: micStatus,
          },
        });

        setPermissions((prev) => ({
          ...prev,
          camera: cameraStatus as PermissionStatus,
          microphone: micStatus as PermissionStatus,
        }));

        return allGranted;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        logger.error({
          event: "permissions.request.error",
          platform: "ios",
          outcome: "error",
          error: { message: error.message, type: error.name },
        });
        return false;
      }
    }

    // Fallback: assume permissions will be requested by WebRTC
    logger.info({
      event: "permissions.result",
      platform: Platform.OS,
      outcome: "success",
      permissions: { camera: "granted", microphone: "granted" },
      note: "fallback_assumed",
    });

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
  const requestNotificationPermission = useCallback(async (): Promise<boolean> => {
    if (Platform.OS !== "android" || Platform.Version < 33) {
      // Notifications don't require runtime permission before Android 13
      setPermissions((prev) => ({ ...prev, notifications: "granted" }));
      return true;
    }

    try {
      const result = await PermissionsAndroid.request("android.permission.POST_NOTIFICATIONS" as (typeof PermissionsAndroid.PERMISSIONS)[keyof typeof PermissionsAndroid.PERMISSIONS]);

      const status = androidResultToStatus(result);
      setPermissions((prev) => ({ ...prev, notifications: status }));
      return status === "granted";
    } catch {
      return false;
    }
  }, []);

  /**
   * Open device settings
   */
  const openSettings = useCallback(async (): Promise<void> => {
    try {
      await Linking.openSettings();
    } catch {
      // Silently ignore error
    }
  }, []);

  /**
   * Show alert when permissions are denied
   */
  const showPermissionDeniedAlert = useCallback(
    (missingPermissions: ("camera" | "microphone")[]) => {
      const names = missingPermissions.map((p) => (p === "camera" ? "Camera" : "Microphone"));
      const isBlocked = missingPermissions.some((p) => permissions[p] === "blocked");

      Alert.alert("Permissions Required", `Chalk needs ${names.join(" and ")} access to make video calls.${isBlocked ? " Please enable in Settings." : ""}`, [
        { text: "Cancel", style: "cancel" },
        ...(isBlocked ? [{ text: "Open Settings", onPress: openSettings }] : [{ text: "Try Again", onPress: requestPermissions }]),
      ]);
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
