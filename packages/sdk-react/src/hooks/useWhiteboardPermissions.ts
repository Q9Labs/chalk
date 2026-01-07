/**
 * useWhiteboardPermissions hook - Whiteboard permission management
 */

import { useCallback, useEffect, useState } from "react";
import { useChalk } from "../context.tsx";

export interface ParticipantPermission {
	id: string;
	displayName: string;
	canDraw: boolean;
	role: "host" | "participant";
}

export interface UseWhiteboardPermissionsResult {
	/** Whether local user can draw */
	canDraw: boolean;
	/** Whether local user can grant permissions (is host) */
	canGrant: boolean;
	/** All participants with their permissions */
	participants: ParticipantPermission[];
	/** Grant permission to a participant */
	grantPermission: (participantId: string) => void;
	/** Revoke permission from a participant */
	revokePermission: (participantId: string) => void;
	/** Grant permission to all participants */
	grantAll: () => void;
	/** Revoke permission from all participants */
	revokeAll: () => void;
}

export function useWhiteboardPermissions(): UseWhiteboardPermissionsResult {
	const { room } = useChalk();
	const [permissions, setPermissions] = useState<Map<string, boolean>>(
		new Map(),
	);

	const localParticipant = room?.localParticipant;
	const isHost = localParticipant?.role === "host";
	const canDraw = room?.canDrawWhiteboard() ?? false;

	useEffect(() => {
		if (!room) return;

		const unsub = room.on("whiteboard-permission-changed", (data) => {
			setPermissions((prev) => {
				const next = new Map(prev);
				next.set(data.participantId, data.canDraw);
				return next;
			});
		});

		return unsub;
	}, [room]);

	const participants: ParticipantPermission[] = Array.from(
		room?.participants.values() ?? [],
	).map((p) => ({
		id: p.id,
		displayName: p.displayName,
		canDraw: p.role === "host" || (permissions.get(p.id) ?? true),
		role: p.role,
	}));

	const grantPermission = useCallback(
		(participantId: string) => {
			room?.grantWhiteboardPermission(participantId);
		},
		[room],
	);

	const revokePermission = useCallback(
		(participantId: string) => {
			room?.revokeWhiteboardPermission(participantId);
		},
		[room],
	);

	const grantAll = useCallback(() => {
		participants
			.filter((p) => p.role !== "host")
			.forEach((p) => room?.grantWhiteboardPermission(p.id));
	}, [room, participants]);

	const revokeAll = useCallback(() => {
		participants
			.filter((p) => p.role !== "host")
			.forEach((p) => room?.revokeWhiteboardPermission(p.id));
	}, [room, participants]);

	return {
		canDraw,
		canGrant: isHost,
		participants,
		grantPermission,
		revokePermission,
		grantAll,
		revokeAll,
	};
}
