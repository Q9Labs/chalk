import type React from "react";
import { useCallback, useEffect, useRef } from "react";

const clamp = (value: number, min: number, max: number) =>
	Math.min(Math.max(value, min), max);

export const useDraggable = (
	targetRef: React.RefObject<HTMLElement | null>,
	options: {
		boundaryRef?: React.RefObject<HTMLElement | null>;
		snapToCorners?: boolean;
		cornerMargin?: number;
		friction?: number;
		bounce?: number;
	} = {},
) => {
	const boundaryRef = options.boundaryRef ?? null;
	const snapToCorners = options.snapToCorners ?? false;
	const cornerMargin = options.cornerMargin ?? 16;
	const friction = options.friction ?? 0.92;

	const positionRef = useRef({ x: 0, y: 0 });
	const startRef = useRef({ x: 0, y: 0 });
	const pointerStartRef = useRef({ x: 0, y: 0 });
	const draggingRef = useRef(false);

	const applyPosition = useCallback((x: number, y: number) => {
		positionRef.current = { x, y };
		const el = targetRef.current;
		if (el) {
			el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
		}
	}, [targetRef]);

	const getBounds = useCallback(() => {
		const el = targetRef.current;
		if (!el) return null;
		const boundaryEl = boundaryRef?.current ?? el.parentElement;
		if (!boundaryEl) return null;

		const boundaryRect = boundaryEl.getBoundingClientRect();
		const elementRect = el.getBoundingClientRect();

		const baseLeft = elementRect.left - positionRef.current.x;
		const baseTop = elementRect.top - positionRef.current.y;

		const minX = boundaryRect.left + cornerMargin - baseLeft;
		const maxX = boundaryRect.right - cornerMargin - elementRect.width - baseLeft;
		const minY = boundaryRect.top + cornerMargin - baseTop;
		const maxY = boundaryRect.bottom - cornerMargin - elementRect.height - baseTop;

		return { minX, maxX, minY, maxY, boundaryRect, elementRect, baseLeft, baseTop };
	}, [boundaryRef, cornerMargin, targetRef]);

	const snapToNearestCorner = useCallback(() => {
		const bounds = getBounds();
		if (!bounds) return;
		const { minX, maxX, minY, maxY } = bounds;
		const { x, y } = positionRef.current;
		const corners = [
			{ x: minX, y: minY },
			{ x: maxX, y: minY },
			{ x: minX, y: maxY },
			{ x: maxX, y: maxY },
		];
		const [firstCorner] = corners;
		if (!firstCorner) return;
		const closest = corners.reduce((best, corner) => {
			const dx = corner.x - x;
			const dy = corner.y - y;
			const dist = dx * dx + dy * dy;
			return dist < best.dist ? { dist, corner } : best;
		}, { dist: Number.POSITIVE_INFINITY, corner: firstCorner }).corner;
		applyPosition(closest.x, closest.y);
	}, [applyPosition, getBounds]);

	const onPointerDown = useCallback((event: React.PointerEvent) => {
		if (event.button !== 0) return;
		draggingRef.current = true;
		pointerStartRef.current = { x: event.clientX, y: event.clientY };
		startRef.current = { ...positionRef.current };
		event.currentTarget.setPointerCapture?.(event.pointerId);
	}, []);

	const onPointerMove = useCallback((event: React.PointerEvent) => {
		if (!draggingRef.current) return;
		const dx = event.clientX - pointerStartRef.current.x;
		const dy = event.clientY - pointerStartRef.current.y;
		let nextX = startRef.current.x + dx;
		let nextY = startRef.current.y + dy;

		const bounds = getBounds();
		if (bounds) {
			nextX = clamp(nextX, bounds.minX, bounds.maxX);
			nextY = clamp(nextY, bounds.minY, bounds.maxY);
		}

		const easedX = positionRef.current.x + (nextX - positionRef.current.x) * friction;
		const easedY = positionRef.current.y + (nextY - positionRef.current.y) * friction;

		applyPosition(easedX, easedY);
	}, [applyPosition, friction, getBounds]);

	const onPointerUp = useCallback(() => {
		if (!draggingRef.current) return;
		draggingRef.current = false;
		if (snapToCorners) {
			snapToNearestCorner();
		}
	}, [snapToCorners, snapToNearestCorner]);

	useEffect(() => {
		const el = targetRef.current;
		if (!el) return;
		el.style.touchAction = "none";
	}, [targetRef]);

	return {
		dragHandlers: {
			onPointerDown,
			onPointerMove,
			onPointerUp,
		},
	};
};

export type UseDraggableOptions = Parameters<typeof useDraggable>[1];
