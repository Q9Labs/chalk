import { useCallback, useState } from "react";
import { useChalk } from "../ChalkProvider";

export interface UseScreenShareResult {
	isScreenSharing: boolean;
	startScreenShare: () => Promise<boolean>;
	stopScreenShare: () => Promise<void>;
	error: Error | null;
}

export function useScreenShare(): UseScreenShareResult {
	const { rtcManager, room } = useChalk();
	const [isScreenSharing, setIsScreenSharing] = useState(false);
	const [error, setError] = useState<Error | null>(null);

	const startScreenShare = useCallback(async (): Promise<boolean> => {
		if (!rtcManager) {
			setError(new Error("RTCManager not initialized"));
			return false;
		}

		try {
			const success = await rtcManager.startScreenShare();
			setIsScreenSharing(success);
			setError(null);

			if (room && success) {
				room.startScreenShare().catch(() => {});
			}

			return success;
		} catch (err) {
			const screenShareError =
				err instanceof Error ? err : new Error("Screen share failed");
			setError(screenShareError);
			return false;
		}
	}, [rtcManager, room]);

	const stopScreenShare = useCallback(async (): Promise<void> => {
		if (!rtcManager) return;

		try {
			await rtcManager.stopScreenShare();
			setIsScreenSharing(false);
			setError(null);

			if (room) {
				room.stopScreenShare();
			}
		} catch (err) {
			const stopError =
				err instanceof Error ? err : new Error("Failed to stop screen share");
			setError(stopError);
		}
	}, [rtcManager, room]);

	return {
		isScreenSharing,
		startScreenShare,
		stopScreenShare,
		error,
	};
}
