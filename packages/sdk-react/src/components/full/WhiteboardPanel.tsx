/**
 * WhiteboardPanel - Integrated collaborative whiteboard using Excalidraw
 *
 * Integrated component that acts as a "Stage" in the video conference.
 * Handles sync, permissions, and participant thumbnails.
 */

import {
	createElement,
	memo,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { useSession } from "../../context/chalk-provider";
import { useWhiteboard } from "../../hooks/features/useWhiteboard";
import { useWhiteboardPermissions } from "../../hooks/useWhiteboardPermissions";
import { cn } from "../../utils/cn";
import { VideoTile } from "../atomic";
import type { Participant } from "../composite/VideoGrid";
import {
	ArrowLeft01Icon,
	ArrowRight01Icon,
	ArrowDown01Icon,
	ArrowUp01Icon,
} from "../../utils/icons";

const LockIcon = () => (
	<svg
		xmlns="http://www.w3.org/2000/svg"
		width="16"
		height="16"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		strokeWidth="2"
		strokeLinecap="round"
		strokeLinejoin="round"
	>
		<rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
		<path d="M7 11V7a5 5 0 0 1 10 0v4" />
	</svg>
);

const UnlockIcon = () => (
	<svg
		xmlns="http://www.w3.org/2000/svg"
		width="16"
		height="16"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		strokeWidth="2"
		strokeLinecap="round"
		strokeLinejoin="round"
	>
		<rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
		<path d="M7 11V7a5 5 0 0 1 9.9-1" />
	</svg>
);

const PencilIcon = () => (
	<svg
		xmlns="http://www.w3.org/2000/svg"
		width="14"
		height="14"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		strokeWidth="2"
		strokeLinecap="round"
		strokeLinejoin="round"
	>
		<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
		<path d="m15 5 4 4" />
	</svg>
);

/** Excalidraw element type (simplified for legacy sync) */
interface ExcalidrawElement {
	id: string;
	version: number;
	isDeleted?: boolean;
	[key: string]: unknown;
}

/** Binary files type */
type BinaryFiles = Record<string, unknown>;

// ExcalidrawCollabEngine is dynamically imported from chalk-whiteboard/collab
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CollabEngine = any;

// SyncEngine is dynamically imported from chalk-whiteboard (legacy v1)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SyncEngine = any;

const CURSOR_STALE_MS = 10000;
const CURSOR_COLORS = [
	{ stroke: "#FF5D5D", background: "rgba(255, 93, 93, 0.2)" },
	{ stroke: "#4CB9FF", background: "rgba(76, 185, 255, 0.2)" },
	{ stroke: "#8B5CF6", background: "rgba(139, 92, 246, 0.2)" },
	{ stroke: "#10B981", background: "rgba(16, 185, 129, 0.2)" },
	{ stroke: "#F59E0B", background: "rgba(245, 158, 11, 0.2)" },
	{ stroke: "#EC4899", background: "rgba(236, 72, 153, 0.2)" },
	{ stroke: "#22D3EE", background: "rgba(34, 211, 238, 0.2)" },
	{ stroke: "#A3E635", background: "rgba(163, 230, 53, 0.2)" },
];

const getCursorColor = (id: string) => {
	let hash = 0;
	for (let i = 0; i < id.length; i += 1) {
		hash = (hash << 5) - hash + id.charCodeAt(i);
		hash |= 0;
	}
	const index = Math.abs(hash) % CURSOR_COLORS.length;
	return CURSOR_COLORS[index];
};

/** CDN URL for Excalidraw CSS - includes fonts via relative paths */
const EXCALIDRAW_CSS_CDN =
	"https://cdn.jsdelivr.net/npm/@excalidraw/excalidraw@0.18.0/dist/prod/index.css";

export interface WhiteboardPanelProps {
	/** Called when whiteboard should close */
	onClose?: () => void;
	/** Controls visibility without unmounting (preserves state) */
	isVisible?: boolean;
	/** Custom CSS class */
	className?: string;
	/**
	 * URL or path to Excalidraw CSS.
	 * Defaults to jsDelivr CDN which includes fonts automatically.
	 * Set to a local path (e.g., "/vendor/excalidraw.css") if self-hosting.
	 */
	excalidrawCssPath?: string;
	/** Theme override */
	theme?: "light" | "dark" | "auto";
	/** List of participants to display in thumbnails */
	participants?: Participant[];
	/** Whether to show participant thumbnails */
	showThumbnails?: boolean;
	/** Position of thumbnails relative to whiteboard */
	thumbnailPosition?: "bottom" | "right";
}

/**
 * Integrated collaborative whiteboard panel
 *
 * Uses Excalidraw with real-time sync via the SDK's whiteboard system.
 * Automatically handles permissions, cursors, and element syncing.
 */
function WhiteboardPanelBase({
	isVisible = true,
	className,
	excalidrawCssPath = EXCALIDRAW_CSS_CDN,
	theme = "auto",
	participants = [],
	showThumbnails = true,
	thumbnailPosition = "bottom",
}: WhiteboardPanelProps): React.JSX.Element {
	const session = useSession();
	const {
		canDraw,
		cursors,
		latestUpdate,
		latestSnapshot,
		sendUpdate,
		sendCursor,
		requestSync,
	} = useWhiteboard();
	const { canGrant, grantAll, revokeAll } = useWhiteboardPermissions();

	const useV2 = session.whiteboardSyncV2 ?? true;

	const syncEngineRef = useRef<SyncEngine | null>(null);
	const collabEngineRef = useRef<CollabEngine | null>(null);
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const excalidrawRef = useRef<any>(null);
	const elementsRef = useRef<readonly ExcalidrawElement[]>([]);
	const filesRef = useRef<Record<string, unknown>>({});
	const containerRef = useRef<HTMLDivElement>(null);

	const [isReady, setIsReady] = useState(false);
	const [cssLoaded, setCssLoaded] = useState(false);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [cursorTick, setCursorTick] = useState(0);

	// Thumbnail state
	const [isThumbnailsOpen, setIsThumbnailsOpen] = useState(true);

	const toggleThumbnails = useCallback(() => {
		setIsThumbnailsOpen((prev) => !prev);
	}, []);

	// Determine theme
	const resolvedTheme =
		theme === "auto"
			? typeof document !== "undefined" &&
				document.documentElement.classList.contains("dark")
				? "dark"
				: "light"
			: theme;

	// Mount Excalidraw using imperative API to avoid React 19 conflicts
	useEffect(() => {
		if (typeof window === "undefined" || !containerRef.current) return;

		let mounted = true;
		let root: ReturnType<typeof import("react-dom/client").createRoot> | null =
			null;

		const loadExcalidraw = async () => {
			try {
				const collabPromise = useV2
					? import("@q9labs/chalk-whiteboard/collab").catch(() => null)
					: Promise.resolve(null);
				const legacyPromise = useV2
					? Promise.resolve(null)
					: import("@q9labs/chalk-whiteboard").catch(() => null);

				// Dynamic imports
				const [{ Excalidraw }, { createRoot }, chalkWhiteboardCollab, chalkWhiteboardLegacy] =
					await Promise.all([
						import("@excalidraw/excalidraw"),
						import("react-dom/client"),
						collabPromise,
						legacyPromise,
					]);

				// Check if Excalidraw CSS is already loaded (via global import or previous mount)
				const cssId = "excalidraw-styles";
				const existingLink = document.getElementById(cssId) as HTMLLinkElement | null;
				const hasGlobalStyles = document.querySelector('style[data-href*="excalidraw"], link[href*="excalidraw"]');

				if (existingLink || hasGlobalStyles) {
					// CSS already loaded globally or from previous mount
					setCssLoaded(true);
				} else {
					// Dynamically inject CSS from CDN
					const link = document.createElement("link");
					link.id = cssId;
					link.rel = "stylesheet";
					link.href = excalidrawCssPath;
					link.onload = () => setCssLoaded(true);
					document.head.appendChild(link);
				}

				if (!mounted || !containerRef.current) return;

				const CollabEngineCtor = (chalkWhiteboardCollab as any)?.ExcalidrawCollabEngine;
				const SyncEngineCtor = (chalkWhiteboardLegacy as any)?.SyncEngine;

				// Create isolated root for Excalidraw
				root = createRoot(containerRef.current);

				const ExcalidrawWrapper = () => {
					const handleChange = useCallback(
						(
							elements: readonly unknown[],
							_appState: unknown,
							files: BinaryFiles,
						) => {
							if (useV2) {
								collabEngineRef.current?.handleChange(
									elements as any,
									_appState as any,
									files,
								);
								return;
							}

							if (!canDraw) return;
							elementsRef.current = elements as readonly ExcalidrawElement[];
							syncEngineRef.current?.handleChange(
								elements as readonly ExcalidrawElement[],
								files,
							);
						},
						[],
					);

					const handlePointerUpdate = useCallback(
						(payload: { pointer: { x: number; y: number } }) => {
							if (useV2) {
								collabEngineRef.current?.handlePointerUpdate(payload);
								return;
							}
							syncEngineRef.current?.sendCursor(
								payload.pointer.x,
								payload.pointer.y,
							);
						},
						[],
					);

					// Theme-aware colors: dark theme = dark canvas, light theme = light canvas
					const isDark = resolvedTheme === "dark";
					const backgroundColor = isDark ? "#121212" : "#ffffff";
					// Stroke color: contrasts with canvas (light on dark, dark on light)
					const strokeColor = isDark ? "#ffffff" : "#1e1e1e";

					return createElement(Excalidraw, {
						excalidrawAPI: (api: unknown) => {
							excalidrawRef.current = api;
							if (useV2 && !collabEngineRef.current && CollabEngineCtor) {
								collabEngineRef.current = new CollabEngineCtor({
									excalidrawAPI: api,
									canDraw,
									sendUpdateV2: (payload: any) => {
										const room = session.room.getRoom();
										room?.sendWhiteboardUpdateV2({
											sceneId: payload.sceneId,
											syncAll: payload.syncAll,
											elements: payload.elements,
											seq: payload.seq,
										});
									},
									sendCursor: (payload: { x: number; y: number }) => {
										const room = session.room.getRoom();
										room?.sendWhiteboardCursor(payload.x, payload.y);
									},
									requestSync: () => {
										const room = session.room.getRoom();
										room?.requestWhiteboardSync();
									},
									sendClear: () => {
										const room = session.room.getRoom();
										room?.clearWhiteboard();
									},
									presignUpload: async (fileId: string, mimeType: string) => {
										const res = await session.whiteboardPresignUpload(fileId, mimeType);
										return { uploadUrl: res.uploadUrl };
									},
									presignDownload: async (fileId: string) => {
										const res = await session.whiteboardPresignDownload(fileId);
										return { downloadUrl: res.downloadUrl };
									},
								});
							}

							if (!useV2 && !syncEngineRef.current && SyncEngineCtor) {
								syncEngineRef.current = new SyncEngineCtor(
									(type: string, payload: unknown) => {
										if (type === "whiteboard.update") {
											const p = payload as {
												elements: unknown[];
												files?: Record<string, unknown>;
												seq: number;
											};
											sendUpdate(p.elements, p.files, p.seq);
										} else if (type === "whiteboard.cursor") {
											const p = payload as { x: number; y: number };
											sendCursor(p.x, p.y);
										}
									},
									{
										debounceMs: 150,
										cursorThrottleMs: 16,
										maxPayloadBytes: 32 * 1024 * 1024,
										maxFileBytes: 32 * 1024 * 1024,
									},
								);
							}
						},
						isCollaborating: true,
						theme: resolvedTheme,
						initialData: {
							appState: {
								viewBackgroundColor: backgroundColor,
								theme: resolvedTheme,
								currentItemStrokeColor: strokeColor,
							},
						},
						onChange: handleChange,
						onPointerUpdate: handlePointerUpdate,
						viewModeEnabled: !canDraw,
						UIOptions: {
							canvasActions: {
								changeViewBackgroundColor: canDraw,
								clearCanvas: canDraw,
								export: {},
								loadScene: false,
								saveToActiveFile: false,
								toggleTheme: false,
							},
						},
						renderTopRightUI: () => null,
					});
				};

				root.render(createElement(ExcalidrawWrapper));
				setIsReady(true);
			} catch (err) {
				setLoadError(
					err instanceof Error ? err.message : "Failed to load whiteboard",
				);
			}
		};

		loadExcalidraw();

		return () => {
			mounted = false;
			collabEngineRef.current?.dispose?.();
			collabEngineRef.current = null;
			syncEngineRef.current?.reset?.();
			syncEngineRef.current = null;
			// Cleanup after delay to avoid React 19 timing issues
			setTimeout(() => {
				root?.unmount();
			}, 0);
		};
	}, [
		canDraw,
		excalidrawCssPath,
		resolvedTheme,
		session,
		sendCursor,
		sendUpdate,
		useV2,
	]);

	// Request initial sync
	useEffect(() => {
		requestSync();
	}, [requestSync]);

	useEffect(() => {
		if (useV2) return;
		const interval = setInterval(() => {
			setCursorTick((prev) => prev + 1);
		}, 1000);
		return () => clearInterval(interval);
	}, [useV2]);

	useEffect(() => {
		if (!useV2) return;
		collabEngineRef.current?.setCanDraw?.(canDraw);
	}, [canDraw, useV2]);

	// Apply remote updates
	useEffect(() => {
		if (!latestUpdate) return;
		if (useV2) {
			collabEngineRef.current?.handleRemoteData({
				sceneId: latestUpdate.sceneId,
				syncAll: latestUpdate.syncAll,
				elements: latestUpdate.elements as unknown[],
			});
			return;
		}

		if (!syncEngineRef.current || !excalidrawRef.current) return;

		const merged = syncEngineRef.current.applyRemoteUpdate(elementsRef.current, {
			elements: latestUpdate.elements as ExcalidrawElement[],
			seq: latestUpdate.seq,
			participantId: latestUpdate.participantId,
		});

		if (latestUpdate.files) {
			filesRef.current = { ...filesRef.current, ...latestUpdate.files };
		}
		elementsRef.current = merged;
		excalidrawRef.current.updateScene({
			elements: merged,
			files: filesRef.current,
		});
	}, [latestUpdate, useV2]);

	// Apply snapshot (full state)
	useEffect(() => {
		if (!latestSnapshot) return;
		if (useV2) {
			collabEngineRef.current?.handleRemoteSnapshot({
				sceneId: latestSnapshot.sceneId,
				elements: latestSnapshot.elements as unknown[],
			});
			return;
		}

		if (!excalidrawRef.current) return;

		elementsRef.current = latestSnapshot.elements as ExcalidrawElement[];
		filesRef.current = latestSnapshot.files ?? {};
		syncEngineRef.current?.loadSnapshot(
			latestSnapshot.elements as ExcalidrawElement[],
			latestSnapshot.lastSeq,
		);
		excalidrawRef.current.updateScene({
			elements: latestSnapshot.elements,
			files: latestSnapshot.files,
			appState: latestSnapshot.appState,
		});
	}, [latestSnapshot, useV2]);

	useEffect(() => {
		if (useV2) {
			return session.whiteboard.on("cursor", (cursor) => {
				collabEngineRef.current?.handleRemoteCursor({
					participantId: cursor.participantId,
					displayName: cursor.displayName,
					x: cursor.x,
					y: cursor.y,
					timestamp: cursor.timestamp instanceof Date
						? cursor.timestamp
						: new Date(cursor.timestamp as unknown as string),
				});
			});
		}

		if (!excalidrawRef.current) {
			return;
		}

		const now = Date.now();
		const collaborators = new Map();

		for (const cursor of cursors) {
			const timestamp = cursor.timestamp instanceof Date
				? cursor.timestamp.getTime()
				: new Date(cursor.timestamp as unknown as string).getTime();
			if (now - timestamp > CURSOR_STALE_MS) {
				continue;
			}

			const color = getCursorColor(cursor.participantId);
			collaborators.set(cursor.participantId, {
				pointer: {
					x: cursor.x,
					y: cursor.y,
					tool: "pointer",
					renderCursor: true,
				},
				username: cursor.displayName,
				color,
				id: cursor.participantId,
				socketId: cursor.participantId,
			});
		}

		excalidrawRef.current.updateScene({ collaborators });
	}, [cursors, cursorTick, session, useV2]);

	// UI styling based on canvas background
	const isDarkTheme = resolvedTheme === "dark";
	const isDarkCanvas = isDarkTheme;
	const pillBg = isDarkCanvas ? "bg-black/50" : "bg-white/80";
	const pillBorder = isDarkCanvas ? "border-white/10" : "border-black/10";
	const pillText = isDarkCanvas ? "text-white/90" : "text-black/90";
	const buttonText = isDarkCanvas ? "text-white/70 hover:text-white" : "text-black/70 hover:text-black";
	const buttonHover = isDarkCanvas ? "hover:bg-white/10" : "hover:bg-black/10";

	return (
		<div
			className={cn(
				"flex h-full w-full gap-2 transition-all duration-500",
				thumbnailPosition === "bottom" ? "flex-col" : "flex-row",
				!isVisible && "hidden",
				className,
			)}
		>
			{/* Main Stage (Excalidraw) */}
			<div className="relative flex-1 min-h-0 min-w-0 rounded-2xl overflow-hidden bg-background">
				{/* Top-left title pill */}
				<div className={cn("absolute top-4 left-4 z-10 rounded-full px-3 py-1.5 backdrop-blur-md border flex items-center gap-2", pillBg, pillBorder)}>
					<PencilIcon />
					<span className={cn("text-sm font-medium", pillText)}>Whiteboard</span>
				</div>

				{/* Top-right actions pill */}
				{canGrant && (
					<div className={cn("absolute top-4 right-4 z-10 rounded-lg p-1 backdrop-blur-md border flex items-center gap-1", pillBg, pillBorder)}>
						<button
							type="button"
							onClick={grantAll}
							className={cn("w-8 h-8 rounded-md flex items-center justify-center transition-colors", buttonText, buttonHover)}
							aria-label="Enable drawing for all"
							title="Enable All"
						>
							<UnlockIcon />
						</button>
						<button
							type="button"
							onClick={revokeAll}
							className={cn("w-8 h-8 rounded-md flex items-center justify-center transition-colors", buttonText, buttonHover)}
							aria-label="Disable drawing for all"
							title="Disable All"
						>
							<LockIcon />
						</button>
					</div>
				)}

				{/* Loading state */}
				{(!isReady || !cssLoaded) && !loadError && (
					<div className="absolute inset-0 flex items-center justify-center text-foreground bg-background z-20">
						<div className="flex flex-col items-center gap-3">
							<div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
							<span>Loading whiteboard...</span>
						</div>
					</div>
				)}

				{/* Error state */}
				{loadError && (
					<div className="absolute inset-0 flex items-center justify-center text-destructive bg-background z-20">
						<div className="flex flex-col items-center gap-3 max-w-md text-center px-4">
							<span className="text-lg font-medium">
								Failed to load whiteboard
							</span>
							<span className="text-sm text-muted-foreground">
								{loadError}
							</span>
						</div>
					</div>
				)}

				{/* Excalidraw mounts here */}
				<div ref={containerRef} className="h-full w-full" />

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
						aria-label={isThumbnailsOpen ? "Collapse sidebar" : "Expand sidebar"}
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

			{/* Thumbnails Strip */}
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
							(thumbnailPosition === "bottom" ? "h-36 w-full" : "w-56 h-full"),
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
}

export const WhiteboardPanel = memo(WhiteboardPanelBase);
WhiteboardPanel.displayName = "WhiteboardPanel";

export default WhiteboardPanel;
