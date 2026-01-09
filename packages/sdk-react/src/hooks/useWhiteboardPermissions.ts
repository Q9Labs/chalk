"use client";

/**
 * useWhiteboardPermissions - Host controls for whiteboard permissions
 *
 * Provides ability to grant/revoke drawing permissions to all participants.
 * Only hosts can use these controls.
 */

import { useCallback, useMemo } from "react";
import { useSession } from "../context/chalk-provider";
import { useParticipants } from "./participants/useParticipants";

export interface UseWhiteboardPermissionsReturn {
	/** Whether local user can grant/revoke permissions (is host) */
	canGrant: boolean;
	/** Grant drawing permission to all participants */
	grantAll: () => void;
	/** Revoke drawing permission from all participants */
	revokeAll: () => void;
	/** Grant permission to specific participant */
	grant: (participantId: string) => void;
	/** Revoke permission from specific participant */
	revoke: (participantId: string) => void;
}

/**
 * Hook for whiteboard permission management (host only)
 *
 * @example
 * ```tsx
 * function WhiteboardControls() {
 *   const { canGrant, grantAll, revokeAll } = useWhiteboardPermissions();
 *
 *   if (!canGrant) return null;
 *
 *   return (
 *     <div>
 *       <button onClick={grantAll}>Enable All</button>
 *       <button onClick={revokeAll}>Disable All</button>
 *     </div>
 *   );
 * }
 * ```
 */
export function useWhiteboardPermissions(): UseWhiteboardPermissionsReturn {
	const session = useSession();
	const { whiteboard } = session;
	const { participants, localParticipant } = useParticipants();

	// Host can grant/revoke permissions
	const canGrant = localParticipant?.role === "host";

	const grant = useCallback(
		(participantId: string): void => {
			whiteboard.grantPermission(participantId);
		},
		[whiteboard],
	);

	const revoke = useCallback(
		(participantId: string): void => {
			whiteboard.revokePermission(participantId);
		},
		[whiteboard],
	);

	const grantAll = useCallback((): void => {
		for (const p of participants) {
			if (!p.isLocal) {
				whiteboard.grantPermission(p.id);
			}
		}
	}, [whiteboard, participants]);

	const revokeAll = useCallback((): void => {
		for (const p of participants) {
			if (!p.isLocal) {
				whiteboard.revokePermission(p.id);
			}
		}
	}, [whiteboard, participants]);

	return useMemo(
		(): UseWhiteboardPermissionsReturn => ({
			canGrant,
			grantAll,
			revokeAll,
			grant,
			revoke,
		}),
		[canGrant, grantAll, revokeAll, grant, revoke],
	);
}
