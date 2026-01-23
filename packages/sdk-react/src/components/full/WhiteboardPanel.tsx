/**
 * WhiteboardPanel - Full-screen collaborative whiteboard using Excalidraw
 *
 * Self-contained component that integrates with the SDK's whiteboard system.
 * Handles sync, permissions, and React 19 compatibility automatically.
 *
 * @example
 * ```tsx
 * const { isOpen, toggle } = useWhiteboard();
 *
 * return isOpen ? <WhiteboardPanel onClose={toggle} /> : null;
 * ```
 */

import { memo, useCallback, useEffect, useRef, useState } from "react";
import { createLogger } from "@q9labs/chalk-core";
import { useWhiteboard } from "../../hooks/features/useWhiteboard";
import { useWhiteboardPermissions } from "../../hooks/useWhiteboardPermissions";
import { cn } from "../../utils/cn";

const log = createLogger("WhiteboardPanel");

// Icons (inline to avoid lucide-react version issues)
const XIcon = () => (
	<svg
		xmlns="http://www.w3.org/2000/svg"
		width="20"
		height="20"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		strokeWidth="2"
		strokeLinecap="round"
		strokeLinejoin="round"
	>
		<path d="M18 6 6 18" />
		<path d="m6 6 12 12" />
	</svg>
);

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

/** Excalidraw element type (simplified for our needs) */
interface ExcalidrawElement {
	id: string;
	version: number;
	isDeleted?: boolean;
	[key: string]: unknown;
}

/** Binary files type */
type BinaryFiles = Record<string, unknown>;

// SyncEngine is dynamically imported from chalk-whiteboard
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SyncEngine = any;

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
}

/**
 * Full-screen collaborative whiteboard panel
 *
 * Uses Excalidraw with real-time sync via the SDK's whiteboard system.
 * Automatically handles permissions, cursors, and element syncing.
 */
function WhiteboardPanelBase({
	onClose,
	isVisible = true,
	className,
	excalidrawCssPath = EXCALIDRAW_CSS_CDN,
	theme = "auto",
}: WhiteboardPanelProps): React.JSX.Element {
	const {
		canDraw,
		latestUpdate,
		sendUpdate,
		sendCursor,
		requestSync,
		notifyOpen,
		notifyClose,
	} = useWhiteboard();
	const { canGrant, grantAll, revokeAll } = useWhiteboardPermissions();

	const syncEngineRef = useRef<SyncEngine | null>(null);
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const excalidrawRef = useRef<any>(null);
	const elementsRef = useRef<readonly ExcalidrawElement[]>([]);
	const containerRef = useRef<HTMLDivElement>(null);

	const [isReady, setIsReady] = useState(false);
	const [cssLoaded, setCssLoaded] = useState(false);
	const [loadError, setLoadError] = useState<string | null>(null);

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
				// Dynamic imports
				const [{ Excalidraw }, { createRoot }, React, chalkWhiteboard] =
					await Promise.all([
						import("@excalidraw/excalidraw"),
						import("react-dom/client"),
						import("react"),
						import("@q9labs/chalk-whiteboard").catch(() => null),
					]);

				// Inject Excalidraw CSS if not already present
				const cssId = "excalidraw-styles";
				const existingLink = document.getElementById(cssId) as HTMLLinkElement | null;
				if (existingLink) {
					// CSS already loaded from previous mount
					setCssLoaded(true);
				} else {
					const link = document.createElement("link");
					link.id = cssId;
					link.rel = "stylesheet";
					link.href = excalidrawCssPath;
					link.onload = () => setCssLoaded(true);
					document.head.appendChild(link);
				}

				if (!mounted || !containerRef.current) return;

				// Initialize SyncEngine if chalk-whiteboard is available
				if (chalkWhiteboard?.SyncEngine) {
					syncEngineRef.current = new chalkWhiteboard.SyncEngine(
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
						{ debounceMs: 150, cursorThrottleMs: 16 },
					);
				}

				// Create isolated root for Excalidraw
				root = createRoot(containerRef.current);

				const ExcalidrawWrapper = () => {
					const handleChange = React.useCallback(
						(
							elements: readonly ExcalidrawElement[],
							_appState: unknown,
							files: BinaryFiles,
						) => {
							if (!canDraw) return;
							elementsRef.current = elements;
							syncEngineRef.current?.handleChange(elements, files);
						},
						[],
					);

					const handlePointerUpdate = React.useCallback(
						(payload: { pointer: { x: number; y: number } }) => {
							if (!canDraw) return;
							syncEngineRef.current?.sendCursor(
								payload.pointer.x,
								payload.pointer.y,
							);
						},
						[],
					);

					// Canvas background - always dark for better drawing experience
					const backgroundColor = "#121212";

					return React.createElement(Excalidraw, {
						excalidrawAPI: (api: unknown) => {
							excalidrawRef.current = api;
						},
						theme: "dark",
						initialData: {
							appState: {
								viewBackgroundColor: backgroundColor,
								theme: "dark",
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

				root.render(React.createElement(ExcalidrawWrapper));
				setIsReady(true);
			} catch (err) {
				log.error("Failed to load Excalidraw:", err);
				setLoadError(
					err instanceof Error ? err.message : "Failed to load whiteboard",
				);
			}
		};

		loadExcalidraw();

		return () => {
			mounted = false;
			// Cleanup after delay to avoid React 19 timing issues
			setTimeout(() => {
				root?.unmount();
			}, 0);
		};
	}, [canDraw, excalidrawCssPath, resolvedTheme, sendCursor, sendUpdate]);

	// Notify others on mount/unmount
	useEffect(() => {
		notifyOpen();
		return () => {
			notifyClose();
		};
	}, [notifyOpen, notifyClose]);

	// Request initial sync
	useEffect(() => {
		requestSync();
		return () => {
			syncEngineRef.current?.reset();
		};
	}, [requestSync]);

	// Apply remote updates
	useEffect(() => {
		if (!latestUpdate || !syncEngineRef.current || !excalidrawRef.current) {
			return;
		}

		const merged = syncEngineRef.current.applyRemoteUpdate(elementsRef.current, {
			elements: latestUpdate.elements as ExcalidrawElement[],
			seq: latestUpdate.seq,
		});

		elementsRef.current = merged;
		excalidrawRef.current.updateScene({ elements: merged });
	}, [latestUpdate]);

	// Close on Escape key
	const handleKeyDown = useCallback(
		(e: KeyboardEvent) => {
			if (e.key === "Escape") {
				onClose?.();
			}
		},
		[onClose],
	);

	useEffect(() => {
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [handleKeyDown]);

	return (
		<div
			className={cn(
				"fixed inset-0 z-50",
				"bg-background",
				!isVisible && "hidden",
				className,
			)}
		>
			{/* Excalidraw Container */}
			<div className="h-full w-full relative">
				{/* Top-left title pill */}
				<div className="absolute top-4 left-4 z-10 rounded-full px-3 py-1.5 bg-black/50 backdrop-blur-md border border-white/10 flex items-center gap-2">
					<PencilIcon />
					<span className="text-white/90 text-sm font-medium">Whiteboard</span>
				</div>

				{/* Top-right actions pill */}
				<div className="absolute top-4 right-4 z-10 rounded-lg p-1 bg-black/40 backdrop-blur-md border border-white/10 flex items-center gap-1">
					{canGrant && (
						<>
							<button
								type="button"
								onClick={grantAll}
								className="w-8 h-8 rounded-md flex items-center justify-center text-white/70 hover:text-white hover:bg-white/10 transition-colors"
								aria-label="Enable drawing for all"
								title="Enable All"
							>
								<UnlockIcon />
							</button>
							<button
								type="button"
								onClick={revokeAll}
								className="w-8 h-8 rounded-md flex items-center justify-center text-white/70 hover:text-white hover:bg-white/10 transition-colors"
								aria-label="Disable drawing for all"
								title="Disable All"
							>
								<LockIcon />
							</button>
							<div className="w-px h-5 bg-white/10 mx-0.5" />
						</>
					)}
					<button
						type="button"
						onClick={onClose}
						className="w-8 h-8 rounded-md flex items-center justify-center text-white/70 hover:text-white hover:bg-white/10 transition-colors"
						aria-label="Close whiteboard"
					>
						<XIcon />
					</button>
				</div>

				{/* Bottom-left status pill */}
				<div className="absolute bottom-4 left-4 z-10 rounded-full px-3 py-1.5 bg-black/50 backdrop-blur-md border border-white/10 flex items-center gap-2">
					<div
						className={cn(
							"w-2 h-2 rounded-full",
							canDraw ? "bg-[#1bb6a6]" : "bg-red-500",
						)}
					/>
					<span className="text-white/90 text-sm">
						{canDraw ? "You can draw" : "View only"}
					</span>
				</div>
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
							<span className="text-xs text-muted-foreground/70">
								Make sure @excalidraw/excalidraw is installed as a peer
								dependency
							</span>
						</div>
					</div>
				)}

				{/* Excalidraw mounts here */}
				<div ref={containerRef} className="h-full w-full" />
			</div>
		</div>
	);
}

export const WhiteboardPanel = memo(WhiteboardPanelBase);
WhiteboardPanel.displayName = "WhiteboardPanel";

export default WhiteboardPanel;
