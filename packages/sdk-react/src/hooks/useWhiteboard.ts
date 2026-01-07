/**
 * useWhiteboard hook - Whiteboard synchronization
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useChalk } from "../context.tsx";

export interface WhiteboardUpdate {
	participantId: string;
	displayName: string;
	elements: unknown[];
	files?: Record<string, unknown>;
	seq: number;
}

export interface WhiteboardCursor {
	participantId: string;
	displayName: string;
	x: number;
	y: number;
}

export interface UseWhiteboardResult {
	/** Whether whiteboard is connected */
	isConnected: boolean;
	/** Whether local user can draw */
	canDraw: boolean;
	/** Latest remote update */
	latestUpdate: WhiteboardUpdate | null;
	/** Remote cursors */
	cursors: Map<string, WhiteboardCursor>;
	/** Send whiteboard update */
	sendUpdate: (
		elements: unknown[],
		files?: Record<string, unknown>,
		seq?: number,
	) => void;
	/** Send cursor position */
	sendCursor: (x: number, y: number) => void;
	/** Clear whiteboard */
	clear: () => void;
	/** Request full sync */
	requestSync: () => void;
	/** Notify others whiteboard is open */
	notifyOpen: () => void;
	/** Notify others whiteboard is closed */
	notifyClose: () => void;
}

export function useWhiteboard(): UseWhiteboardResult {
	const { room } = useChalk();
	const [isConnected, setIsConnected] = useState(false);
	const [canDraw, setCanDraw] = useState(true);
	const [latestUpdate, setLatestUpdate] = useState<WhiteboardUpdate | null>(
		null,
	);
	const [cursors, setCursors] = useState<Map<string, WhiteboardCursor>>(
		new Map(),
	);

	const subscribedRoomRef = useRef<typeof room>(null);

	useEffect(() => {
		console.log("[useWhiteboard] Effect running, room:", room ? "exists" : "null");

		if (!room) {
			console.log("[useWhiteboard] No room, cleaning up state");
			if (subscribedRoomRef.current) {
				subscribedRoomRef.current = null;
				setIsConnected(false);
				setLatestUpdate(null);
				setCursors(new Map());
			}
			return;
		}

		if (subscribedRoomRef.current === room) {
			console.log("[useWhiteboard] Already subscribed to this room");
			return;
		}

		console.log("[useWhiteboard] Setting up subscriptions for room:", room.id);
		subscribedRoomRef.current = room;
		setIsConnected(room.status === "connected");
		setCanDraw(room.canDrawWhiteboard());

		// Listen for updates
		const unsubUpdate = room.on("whiteboard-update", (update) => {
			console.log("[useWhiteboard] Received whiteboard-update:", {
				participantId: update.participantId,
				displayName: update.displayName,
				seq: update.seq,
				elementsCount: update.elements?.length ?? 0,
			});
			setLatestUpdate(update);
		});

		// Listen for cursors
		const unsubCursor = room.on("whiteboard-cursor", (cursor) => {
			// Don't log cursor - too noisy
			setCursors((prev) => {
				const next = new Map(prev);
				next.set(cursor.participantId, cursor);
				return next;
			});
		});

		// Listen for permission changes
		const unsubPermission = room.on("whiteboard-permission-changed", (data) => {
			console.log("[useWhiteboard] Received whiteboard-permission-changed:", data);
			if (data.participantId === room.localParticipant?.id) {
				setCanDraw(data.canDraw);
			}
		});

		// Listen for status changes
		const unsubStatus = room.on("status-changed", (status) => {
			console.log("[useWhiteboard] Room status changed:", status);
			setIsConnected(status === "connected");
		});

		// Clean up stale cursors every 3 seconds
		const cursorCleanup = setInterval(() => {
			setCursors((prev) => {
				// Just return the same map for now
				// In a real impl we'd track timestamps and remove old cursors
				return prev;
			});
		}, 3000);

		console.log("[useWhiteboard] Subscriptions set up successfully");

		return () => {
			console.log("[useWhiteboard] Cleaning up subscriptions");
			unsubUpdate();
			unsubCursor();
			unsubPermission();
			unsubStatus();
			clearInterval(cursorCleanup);
			subscribedRoomRef.current = null;
		};
	}, [room]);

	const sendUpdate = useCallback(
		(elements: unknown[], files?: Record<string, unknown>, seq?: number) => {
			console.log("[useWhiteboard] sendUpdate called:", {
				elementsCount: elements.length,
				hasFiles: !!files,
				seq,
				hasRoom: !!room,
			});
			room?.sendWhiteboardUpdate(elements, files, seq);
		},
		[room],
	);

	const sendCursor = useCallback(
		(x: number, y: number) => {
			// Don't log cursor - too noisy
			room?.sendWhiteboardCursor(x, y);
		},
		[room],
	);

	const clear = useCallback(() => {
		console.log("[useWhiteboard] clear called, hasRoom:", !!room);
		room?.clearWhiteboard();
	}, [room]);

	const requestSync = useCallback(() => {
		console.log("[useWhiteboard] requestSync called, hasRoom:", !!room);
		room?.requestWhiteboardSync();
	}, [room]);

	const notifyOpen = useCallback(() => {
		console.log("[useWhiteboard] notifyOpen called, hasRoom:", !!room);
		room?.openWhiteboard();
	}, [room]);

	const notifyClose = useCallback(() => {
		console.log("[useWhiteboard] notifyClose called, hasRoom:", !!room);
		room?.closeWhiteboard();
	}, [room]);

	return {
		isConnected,
		canDraw,
		latestUpdate,
		cursors,
		sendUpdate,
		sendCursor,
		clear,
		requestSync,
		notifyOpen,
		notifyClose,
	};
}
