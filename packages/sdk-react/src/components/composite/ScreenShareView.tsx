import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../../utils/cn";
import {
	ArrowDown01Icon,
	ArrowLeft01Icon,
	ArrowRight01Icon,
	ArrowUp01Icon,
	Maximize01Icon,
	Monitor01Icon,
	RefreshIcon,
	ZoomInIcon,
	ZoomOutIcon,
} from "../../utils/icons";
import { Spinner, VideoTile } from "../atomic";
import { ScreenAnnotationsLayer } from "./screen-annotations/ScreenAnnotationsLayer";
import type { Participant } from "./VideoGrid";

export interface ScreenShareViewProps {
	screenShareTrack: MediaStreamTrack;
	sharedByName: string;
	participants: Participant[];
	onStopShare?: () => void;
	showThumbnails?: boolean;
	thumbnailPosition?: "bottom" | "right";
	enableZoom?: boolean;
	enableAnnotations?: boolean;
	className?: string;
}

const MIN_ZOOM = 1;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.5;

const getContainedSize = (
	containerWidth: number,
	containerHeight: number,
	videoWidth: number,
	videoHeight: number,
) => {
	if (!containerWidth || !containerHeight || !videoWidth || !videoHeight) {
		return {
			width: containerWidth,
			height: containerHeight,
		};
	}

	const containerRatio = containerWidth / containerHeight;
	const videoRatio = videoWidth / videoHeight;

	if (videoRatio > containerRatio) {
		return {
			width: containerWidth,
			height: containerWidth / videoRatio,
		};
	}

	return {
		width: containerHeight * videoRatio,
		height: containerHeight,
	};
};

export const ScreenShareView = React.memo(
	({
		screenShareTrack,
		sharedByName,
		participants,
		onStopShare,
		showThumbnails = true,
		thumbnailPosition = "bottom",
		enableZoom = true,
		enableAnnotations = true,
		className,
	}: ScreenShareViewProps) => {
		const videoRef = useRef<HTMLVideoElement>(null);
		const containerRef = useRef<HTMLDivElement>(null);

		// Loading state
		const [isLoading, setIsLoading] = useState(true);

		// Sidebar/Thumbnails state
		const [isThumbnailsOpen, setIsThumbnailsOpen] = useState(true);

		// Rotation state
		const [rotation, setRotation] = useState(0);
		const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
		const [videoSize, setVideoSize] = useState({ width: 0, height: 0 });

		// Zoom state
		const [zoom, setZoom] = useState(1);
		const [pan, setPan] = useState({ x: 0, y: 0 });
		const [isDragging, setIsDragging] = useState(false);
		const dragStart = useRef({ x: 0, y: 0, panX: 0, panY: 0 });

		useEffect(() => {
			const videoEl = videoRef.current;
			if (!videoEl || !screenShareTrack) return;

			if (screenShareTrack.readyState === "ended") {
				return;
			}

			setIsLoading(true);

			try {
				const stream = new MediaStream([screenShareTrack]);
				videoEl.srcObject = stream;
				videoEl.play().catch(() => {
					// Play failed - may be user interaction required
				});
			} catch {
				// Failed to create MediaStream
			}

			return () => {
				videoEl.srcObject = null;
			};
		}, [screenShareTrack]);

		useEffect(() => {
			const element = containerRef.current;
			if (!element) {
				return;
			}

			const updateSize = () => {
				const rect = element.getBoundingClientRect();
				setContainerSize({ width: rect.width, height: rect.height });
			};

			updateSize();

			const observer = new ResizeObserver(updateSize);
			observer.observe(element);

			return () => observer.disconnect();
		}, []);

		const handleVideoLoaded = useCallback(() => {
			setIsLoading(false);
			if (videoRef.current) {
				setVideoSize({
					width: videoRef.current.videoWidth,
					height: videoRef.current.videoHeight,
				});
			}
		}, []);

		// Reset pan when zoom resets
		useEffect(() => {
			if (zoom === 1) {
				setPan({ x: 0, y: 0 });
			}
		}, [zoom]);

		const handleZoomIn = useCallback(() => {
			setZoom((z) => Math.min(z + ZOOM_STEP, MAX_ZOOM));
		}, []);

		const handleZoomOut = useCallback(() => {
			setZoom((z) => Math.max(z - ZOOM_STEP, MIN_ZOOM));
		}, []);

		const handleResetZoom = useCallback(() => {
			setZoom(1);
			setPan({ x: 0, y: 0 });
			setRotation(0);
		}, []);

		const toggleRotation = useCallback(() => {
			setRotation((prev) => (prev - 90) % 360);
			setZoom(1);
			setPan({ x: 0, y: 0 });
		}, []);

		const stageSize = useMemo(
			() =>
				getContainedSize(
					containerSize.width,
					containerSize.height,
					videoSize.width,
					videoSize.height,
				),
			[containerSize.height, containerSize.width, videoSize.height, videoSize.width],
		);

		const stageStyle = useMemo(
			() => ({
				width: stageSize.width || containerSize.width,
				height: stageSize.height || containerSize.height,
				transform: `translate(calc(-50% + ${pan.x}px), calc(-50% + ${pan.y}px)) rotate(${rotation}deg) scale(${zoom})`,
				transformOrigin: "center center",
			}),
			[containerSize.height, containerSize.width, pan.x, pan.y, rotation, stageSize.height, stageSize.width, zoom],
		);

		// Mouse wheel zoom
		const handleWheel = useCallback(
			(e: React.WheelEvent) => {
				if (!enableZoom) return;
				e.preventDefault();
				const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
				setZoom((z) => Math.max(MIN_ZOOM, Math.min(z + delta, MAX_ZOOM)));
			},
			[enableZoom],
		);

		// Pan handlers
		const handleMouseDown = useCallback(
			(e: React.MouseEvent) => {
				if (
					e.target !== e.currentTarget &&
					e.target !== videoRef.current
				) {
					return;
				}

				if (zoom <= 1) return;
				setIsDragging(true);
				dragStart.current = {
					x: e.clientX,
					y: e.clientY,
					panX: pan.x,
					panY: pan.y,
				};
			},
			[zoom, pan],
		);

		const handleMouseMove = useCallback(
			(e: React.MouseEvent) => {
				if (!isDragging || zoom <= 1) return;

				const dx = e.clientX - dragStart.current.x;
				const dy = e.clientY - dragStart.current.y;

				const maxPanX = (stageSize.width * (zoom - 1)) / 2;
				const maxPanY = (stageSize.height * (zoom - 1)) / 2;
				setPan({
					x: Math.max(-maxPanX, Math.min(maxPanX, dragStart.current.panX + dx)),
					y: Math.max(-maxPanY, Math.min(maxPanY, dragStart.current.panY + dy)),
				});
			},
			[isDragging, stageSize.height, stageSize.width, zoom],
		);

		const handleMouseUp = useCallback(() => {
			setIsDragging(false);
		}, []);

		const handleMouseLeave = useCallback(() => {
			setIsDragging(false);
		}, []);

		const toggleThumbnails = useCallback(() => {
			setIsThumbnailsOpen((prev) => !prev);
		}, []);

		return (
			<div
				className={cn(
					"flex h-full w-full gap-2 transition-all duration-500",
					thumbnailPosition === "bottom" ? "flex-col" : "flex-row",
					className,
				)}
			>
				<div
					ref={containerRef}
					className="relative flex-1 min-h-0 min-w-0 rounded-2xl overflow-hidden bg-black group"
					onWheel={handleWheel}
					onMouseDown={handleMouseDown}
					onMouseMove={handleMouseMove}
					onMouseUp={handleMouseUp}
					onMouseLeave={handleMouseLeave}
				>
					{/* Loading State */}
					{isLoading && (
						<div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-zinc-900/50 backdrop-blur-md transition-opacity duration-500">
							<div className="relative">
								<div className="absolute -inset-4 rounded-full bg-primary/20 blur-xl animate-pulse" />
								<Spinner size="lg" className="text-primary relative z-10" />
							</div>
							<div className="mt-6 flex flex-col items-center gap-2 animate-in fade-in slide-in-from-bottom-4 duration-700 delay-300">
								<div className="flex items-center gap-2 text-white/90 font-medium">
									<Monitor01Icon size={18} className="text-primary" />
									<span>Connecting to {sharedByName}'s screen...</span>
								</div>
								<p className="text-xs text-white/50">
									Setting up the high-quality stream
								</p>
							</div>
						</div>
					)}

					<div
						className="absolute left-1/2 top-1/2"
						style={stageStyle}
					>
						<video
							ref={videoRef}
							autoPlay
							playsInline
							muted
							onLoadedData={handleVideoLoaded}
							onLoadedMetadata={handleVideoLoaded}
							className={cn(
								"h-full w-full rounded-xl bg-black transition-all duration-700",
								isLoading ? "opacity-0 scale-95" : "opacity-100 scale-100",
								zoom > 1 && isDragging && "cursor-grabbing",
								zoom > 1 && !isDragging && "cursor-grab",
							)}
						/>
						<ScreenAnnotationsLayer enabled={enableAnnotations} />
					</div>

					<div
						className={cn(
							"absolute top-3 left-3 px-2 py-1 rounded-full bg-secondary/80 backdrop-blur-sm text-secondary-foreground text-xs font-medium transition-opacity duration-500",
							isLoading ? "opacity-0" : "opacity-100",
						)}
					>
						Shared by {sharedByName}
					</div>

					{/* Zoom controls */}
					{enableZoom && (
						<div className="absolute top-3 right-3 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
							<button
								onClick={toggleRotation}
								className={cn(
									"p-1.5 rounded-full bg-zinc-900/90 backdrop-blur-md text-white border border-white/10 hover:bg-zinc-800 transition-all mr-1",
									rotation !== 0 && "text-primary border-primary/50",
								)}
								aria-label="Rotate view"
							>
								<RefreshIcon
									size={14}
									style={{ transform: `rotate(${-rotation}deg)` }}
									className="transition-transform duration-500 ease-in-out"
								/>
							</button>
							<div className="w-px h-4 bg-white/20 mx-1" />
							<button
								onClick={handleZoomOut}
								disabled={zoom <= MIN_ZOOM}
								className="p-1.5 rounded-full bg-zinc-900/90 backdrop-blur-md text-white border border-white/10 hover:bg-zinc-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
								aria-label="Zoom out"
							>
								<ZoomOutIcon size={14} />
							</button>
							<span className="px-1.5 py-0.5 rounded-full bg-zinc-900/90 backdrop-blur-md text-white border border-white/10 text-xs font-medium min-w-[2.5rem] text-center">
								{Math.round(zoom * 100)}%
							</span>
							<button
								onClick={handleZoomIn}
								disabled={zoom >= MAX_ZOOM}
								className="p-1.5 rounded-full bg-zinc-900/90 backdrop-blur-md text-white border border-white/10 hover:bg-zinc-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
								aria-label="Zoom in"
							>
								<ZoomInIcon size={14} />
							</button>
							{(zoom > 1 || rotation !== 0) && (
								<button
									onClick={handleResetZoom}
									className="p-1.5 rounded-full bg-zinc-900/90 backdrop-blur-md text-white border border-white/10 hover:bg-zinc-800 transition-colors ml-0.5"
									aria-label="Reset zoom"
								>
									<Maximize01Icon size={14} />
								</button>
							)}
						</div>
					)}

					{/* Zoom indicator when zoomed */}
					{zoom > 1 && (
						<div className="absolute bottom-3 right-3 px-1.5 py-0.5 rounded bg-secondary/80 backdrop-blur-sm text-secondary-foreground text-[10px]">
							Drag to pan • Scroll to zoom
						</div>
					)}

					{onStopShare && (
						<div className="absolute bottom-4 left-1/2 -translate-x-1/2 opacity-0 group-hover:opacity-100 transition-opacity">
							<button
								onClick={onStopShare}
								className="px-4 py-2 bg-destructive hover:bg-destructive/90 text-destructive-foreground rounded-md font-medium shadow-lg transition-colors"
							>
								Stop Sharing
							</button>
						</div>
					)}

					{/* Collapse/Expand Toggle Button */}
					{showThumbnails && participants.length > 0 && (
						<button
							onClick={toggleThumbnails}
							className={cn(
								"absolute z-20 flex items-center justify-center bg-zinc-950/50 backdrop-blur-md border border-white/10 text-white/80 hover:text-white hover:bg-zinc-950/80 transition-all duration-300 shadow-lg",
								thumbnailPosition === "right"
									? "top-1/2 -translate-y-1/2 right-1 w-6 h-12 rounded-l-xl"
									: "left-1/2 -translate-x-1/2 bottom-1 w-12 h-6 rounded-t-xl",
							)}
							aria-label={
								isThumbnailsOpen ? "Collapse sidebar" : "Expand sidebar"
							}
						>
							{thumbnailPosition === "right" ? (
								isThumbnailsOpen ? (
									<ArrowRight01Icon size={16} />
								) : (
									<ArrowLeft01Icon size={16} />
								)
							) : isThumbnailsOpen ? (
								<ArrowDown01Icon size={16} />
							) : (
								<ArrowUp01Icon size={16} />
							)}
						</button>
					)}
				</div>

				{showThumbnails && participants.length > 0 && (
					<div
						className={cn(
							"flex gap-2 transition-all duration-500 ease-in-out",
							thumbnailPosition === "bottom"
								? "flex-row items-center px-2 overflow-auto"
								: "flex-col py-2 overflow-y-auto overflow-x-hidden",
							!isThumbnailsOpen &&
								(thumbnailPosition === "bottom"
									? "h-0 opacity-0"
									: "w-0 opacity-0 px-0"),
							isThumbnailsOpen &&
								(thumbnailPosition === "bottom"
									? "h-36 w-full"
									: "w-56 h-full"),
						)}
					>
						{participants.map((p) => (
							<div
								key={p.id}
								className={cn(
									"shrink-0 rounded-xl overflow-hidden relative transition-all duration-500",
									thumbnailPosition === "bottom"
										? "aspect-video h-full"
										: "aspect-video w-full",
									!isThumbnailsOpen && "scale-0 opacity-0",
								)}
							>
								<VideoTile
									participant={{
										id: p.id,
										displayName: p.displayName,
										isLocal: p.isLocal,
										isSpeaking: p.isSpeaking,
										isMuted: p.isMuted,
										isVideoEnabled: p.isVideoEnabled,
										isScreenSharing: p.isScreenSharing,
										isHandRaised: p.isHandRaised,
										connectionQuality:
											p.connectionQuality && p.connectionQuality > 0
												? (p.connectionQuality as 1 | 2 | 3 | 4)
												: undefined,
										avatarUrl: p.avatarUrl,
									}}
									videoTrack={p.videoTrack}
									className="w-full h-full"
									showName={true}
									showStatus={true}
								/>
							</div>
						))}
					</div>
				)}
			</div>
		);
	},
);

ScreenShareView.displayName = "ScreenShareView";
