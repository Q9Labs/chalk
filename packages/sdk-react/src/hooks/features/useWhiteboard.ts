"use client";

/**
 * useWhiteboard - Whiteboard from WhiteboardManager
 */

import type { WhiteboardCursor, WhiteboardState } from "@q9labs/chalk-core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSession } from "../../context/chalk-provider";

export interface UseWhiteboardReturn {
	/** Whether whiteboard is open */
	isOpen: boolean;
	/** Whether local user can draw */
	canDraw: boolean;
	/** Current elements */
	elements: readonly unknown[];
	/** Remote cursors */
	cursors: readonly WhiteboardCursor[];
	/** Current sequence number */
	lastSeq: number;
	/** Participants who have whiteboard open */
	openParticipants: readonly string[];
	/** Open whiteboard */
	open: () => void;
	/** Close whiteboard */
	close: () => void;
	/** Toggle whiteboard */
	toggle: () => void;
	/** Send elements update */
	sendUpdate: (elements: unknown[], files?: Record<string, unknown>) => void;
	/** Send cursor position */
	sendCursor: (x: number, y: number) => void;
	/** Request sync from others */
	requestSync: () => void;
	/** Clear whiteboard */
	clear: () => void;
	/** Grant permission (host only) */
	grantPermission: (participantId: string) => void;
	/** Revoke permission (host only) */
	revokePermission: (participantId: string) => void;
}

/**
 * Hook for whiteboard collaboration
 *
 * @example
 * ```tsx
 * function WhiteboardButton() {
 *   const { isOpen, toggle, canDraw } = useWhiteboard();
 *
 *   return (
 *     <button onClick={toggle} disabled={!canDraw}>
 *       {isOpen ? 'Close Whiteboard' : 'Open Whiteboard'}
 *     </button>
 *   );
 * }
 * ```
 */
export function useWhiteboard(): UseWhiteboardReturn {
	const session = useSession();
	const { whiteboard } = session;

	const [state, setState] = useState<WhiteboardState>(() =>
		whiteboard.getState(),
	);

	useEffect(() => {
		return whiteboard.subscribe(setState);
	}, [whiteboard]);

	const open = useCallback((): void => whiteboard.open(), [whiteboard]);

	const close = useCallback((): void => whiteboard.close(), [whiteboard]);

	const toggle = useCallback((): void => {
		if (state.isOpen) {
			whiteboard.close();
		} else {
			whiteboard.open();
		}
	}, [whiteboard, state.isOpen]);

	const sendUpdate = useCallback(
		(elements: unknown[], files?: Record<string, unknown>): void =>
			whiteboard.sendUpdate(elements, files),
		[whiteboard],
	);

	const sendCursor = useCallback(
		(x: number, y: number): void => whiteboard.sendCursor(x, y),
		[whiteboard],
	);

	const requestSync = useCallback(
		(): void => whiteboard.requestSync(),
		[whiteboard],
	);

	const clear = useCallback((): void => whiteboard.clear(), [whiteboard]);

	const grantPermission = useCallback(
		(participantId: string): void => whiteboard.grantPermission(participantId),
		[whiteboard],
	);

	const revokePermission = useCallback(
		(participantId: string): void => whiteboard.revokePermission(participantId),
		[whiteboard],
	);

	return useMemo(
		(): UseWhiteboardReturn => ({
			isOpen: state.isOpen,
			canDraw: state.canDraw,
			elements: state.elements,
			cursors: state.cursors,
			lastSeq: state.lastSeq,
			openParticipants: state.openParticipants,
			open,
			close,
			toggle,
			sendUpdate,
			sendCursor,
			requestSync,
			clear,
			grantPermission,
			revokePermission,
		}),
		[
			state,
			open,
			close,
			toggle,
			sendUpdate,
			sendCursor,
			requestSync,
			clear,
			grantPermission,
			revokePermission,
		],
	);
}
