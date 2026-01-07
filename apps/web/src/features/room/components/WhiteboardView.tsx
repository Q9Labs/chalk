/**
 * WhiteboardView - Full-screen collaborative whiteboard using Excalidraw
 *
 * IMPORTANT: Excalidraw + React 19 + Vite Compatibility Notes
 * ===========================================================
 *
 * Excalidraw requires special handling due to React 19 incompatibilities:
 *
 * 1. ISOLATED REACT ROOT (Required)
 *    - Excalidraw directly manipulates the DOM which conflicts with React 19's
 *      concurrent rendering. Using `createRoot()` to create an isolated root
 *      prevents "removeChild" and "appendChild" errors.
 *
 * 2. CSS LOADING (Critical - COPY THE CSS FILE!)
 *    - DO NOT import CSS directly: `import "@excalidraw/excalidraw/index.css"`
 *      This WILL FAIL in Vite with "Cannot find module" or "No known conditions" errors.
 *    - DO NOT use `?url` suffix imports - Excalidraw's package.json exports block them.
 *    - SOLUTION: Copy the CSS to public/vendor/ and load via <link> tag:
 *      ```bash
 *      cp node_modules/@excalidraw/excalidraw/dist/prod/index.css public/vendor/excalidraw.css
 *      ```
 *    - Then dynamically inject: `link.href = "/vendor/excalidraw.css"`
 *    - UPDATE CSS when upgrading Excalidraw version!
 *
 * 3. LAZY LOADING
 *    - Always lazy load Excalidraw - it's ~390KB gzipped
 *    - Use client-side only loading with `typeof window === "undefined"` check
 *
 * 4. CLEANUP
 *    - Use setTimeout when unmounting the isolated root to avoid React 19 timing issues
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { X, Lock, Unlock } from "lucide-react";
import { useWhiteboard, useWhiteboardPermissions } from "@q9labs/chalk-react";
import {
	SyncEngine,
	type ExcalidrawElement,
	type BinaryFiles,
} from "@q9labs/chalk-whiteboard";

interface WhiteboardViewProps {
	onClose: () => void;
}

export function WhiteboardView({ onClose }: WhiteboardViewProps) {
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

	// Client-side only rendering for Excalidraw
	const [isReady, setIsReady] = useState(false);
	const [loadError, setLoadError] = useState<string | null>(null);

	// Mount Excalidraw using imperative API to avoid React 19 conflicts
	// NOTE: Excalidraw requires special handling in React 19:
	// 1. Must use isolated React root (createRoot) to avoid DOM conflicts
	// 2. CSS must be loaded dynamically via Vite's ?url import
	// 3. Do NOT try to import "@excalidraw/excalidraw/index.css" directly - it won't resolve
	useEffect(() => {
		if (typeof window === "undefined" || !containerRef.current) return;

		let mounted = true;
		let root: ReturnType<typeof import("react-dom/client").createRoot> | null = null;

		const loadExcalidraw = async () => {
			try {
				const [{ Excalidraw }, { createRoot }, React] = await Promise.all([
					import("@excalidraw/excalidraw"),
					import("react-dom/client"),
					import("react"),
				]);

				// Inject Excalidraw CSS if not already present
				// NOTE: CSS is copied to public/vendor/excalidraw.css from node_modules
				// Direct imports like "@excalidraw/excalidraw/index.css" don't work in Vite
				const cssId = "excalidraw-styles";
				if (!document.getElementById(cssId)) {
					const link = document.createElement("link");
					link.id = cssId;
					link.rel = "stylesheet";
					link.href = "/vendor/excalidraw.css";
					document.head.appendChild(link);
				}

				if (!mounted || !containerRef.current) return;

				// Create a dedicated root for Excalidraw
				root = createRoot(containerRef.current);

				const ExcalidrawWrapper = () => {
					const handleChange = React.useCallback(
						(elements: readonly ExcalidrawElement[], _appState: unknown, files: BinaryFiles) => {
							if (!canDraw) return;
							elementsRef.current = elements;
							syncEngineRef.current?.handleChange(elements, files);
						},
						[]
					);

					const handlePointerUpdate = React.useCallback(
						(payload: { pointer: { x: number; y: number } }) => {
							if (!canDraw) return;
							syncEngineRef.current?.sendCursor(payload.pointer.x, payload.pointer.y);
						},
						[]
					);

					const rootStyles = getComputedStyle(document.documentElement);
					const backgroundColor =
						rootStyles.getPropertyValue("--background").trim() ||
						(rootStyles.getPropertyValue("--chalk-bg-stage").trim() ||
							"#0f1115");
					const isDark = document.documentElement.classList.contains("dark");

					return React.createElement(Excalidraw, {
						excalidrawAPI: (api: unknown) => {
							excalidrawRef.current = api;
						},
						initialData: {
							appState: {
								viewBackgroundColor: backgroundColor,
								theme: isDark ? "dark" : "light",
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
					});
				};

				root.render(React.createElement(ExcalidrawWrapper));
				setIsReady(true);
			} catch (err) {
				console.error("Failed to load Excalidraw:", err);
				setLoadError(err instanceof Error ? err.message : "Failed to load whiteboard");
			}
		};

		loadExcalidraw();

		return () => {
			mounted = false;
			// Cleanup the root after a small delay to let React 19 finish
			setTimeout(() => {
				root?.unmount();
			}, 0);
		};
	}, [canDraw]);

	// Notify others on mount/unmount
	useEffect(() => {
		console.log("[WhiteboardView] Component mounted, calling notifyOpen");
		notifyOpen();
		return () => {
			console.log("[WhiteboardView] Component unmounting, calling notifyClose");
			notifyClose();
		};
	}, [notifyOpen, notifyClose]);

	// Initialize sync engine
	useEffect(() => {
		console.log("[WhiteboardView] Initializing sync engine");
		syncEngineRef.current = new SyncEngine(
			(type: string, payload: unknown) => {
				console.log("[WhiteboardView] SyncEngine callback:", type, payload);
				if (type === "whiteboard.update") {
					const p = payload as {
						elements: unknown[];
						files?: Record<string, unknown>;
						seq: number;
					};
					console.log("[WhiteboardView] Sending update via sendUpdate:", {
						elementsCount: p.elements.length,
						seq: p.seq,
					});
					sendUpdate(p.elements, p.files, p.seq);
				} else if (type === "whiteboard.cursor") {
					const p = payload as { x: number; y: number };
					sendCursor(p.x, p.y);
				}
			},
			{ debounceMs: 150, cursorThrottleMs: 16 },
		);

		// Request initial state
		console.log("[WhiteboardView] Requesting initial sync");
		requestSync();

		return () => {
			console.log("[WhiteboardView] Cleaning up sync engine");
			syncEngineRef.current?.reset();
		};
	}, [sendUpdate, sendCursor, requestSync]);

	// Apply remote updates
	useEffect(() => {
		console.log("[WhiteboardView] latestUpdate effect triggered:", {
			hasUpdate: !!latestUpdate,
			hasSyncEngine: !!syncEngineRef.current,
			hasExcalidraw: !!excalidrawRef.current,
		});

		if (!latestUpdate || !syncEngineRef.current || !excalidrawRef.current) {
			console.log("[WhiteboardView] Skipping update - missing dependencies");
			return;
		}

		console.log("[WhiteboardView] Applying remote update:", {
			participantId: latestUpdate.participantId,
			displayName: latestUpdate.displayName,
			seq: latestUpdate.seq,
			elementsCount: latestUpdate.elements?.length ?? 0,
		});

		const merged = syncEngineRef.current.applyRemoteUpdate(
			elementsRef.current,
			{
				elements: latestUpdate.elements as ExcalidrawElement[],
				seq: latestUpdate.seq,
			},
		);

		console.log("[WhiteboardView] Merged elements count:", merged.length);
		elementsRef.current = merged;
		excalidrawRef.current.updateScene({ elements: merged });
		console.log("[WhiteboardView] Scene updated successfully");
	}, [latestUpdate]);

	// Close on Escape key
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				onClose();
			}
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [onClose]);

	return (
		<div className="fixed inset-0 z-50 bg-background flex flex-col">
			{/* Header */}
			<div className="h-14 bg-card border-b border-border flex items-center justify-between px-4">
				<h1 className="text-foreground font-semibold text-lg">Whiteboard</h1>

				<div className="flex items-center gap-3">
					{/* Permission controls (host only) */}
					{canGrant && (
						<div className="flex items-center gap-2">
							<button
								type="button"
								onClick={grantAll}
								className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-sm rounded-lg transition-colors"
							>
								<Unlock size={16} />
								Enable All
							</button>
							<button
								type="button"
								onClick={revokeAll}
								className="flex items-center gap-1.5 px-3 py-1.5 bg-destructive hover:bg-destructive/90 text-destructive-foreground text-sm rounded-lg transition-colors"
							>
								<Lock size={16} />
								Disable All
							</button>
						</div>
					)}

					{/* Permission indicator */}
					<div
						className={`px-3 py-1.5 rounded-lg text-sm ${canDraw ? "bg-emerald-500/15 text-emerald-500" : "bg-destructive/15 text-destructive"}`}
					>
						{canDraw ? "You can draw" : "View only"}
					</div>

					{/* Close button */}
					<button
						type="button"
						onClick={onClose}
						className="p-2 hover:bg-muted rounded-lg transition-colors text-muted-foreground hover:text-foreground"
					>
						<X size={20} />
					</button>
				</div>
			</div>

			{/* Excalidraw Container */}
			<div className="flex-1 relative">
				{/* Loading state */}
				{!isReady && !loadError && (
					<div className="absolute inset-0 flex items-center justify-center text-foreground bg-background z-10">
						Loading whiteboard...
					</div>
				)}
				{/* Error state */}
				{loadError && (
					<div className="absolute inset-0 flex items-center justify-center text-destructive bg-background z-10">
						Error: {loadError}
					</div>
				)}
				{/* Excalidraw mounts here */}
				<div ref={containerRef} className="h-full w-full" />
			</div>
		</div>
	);
}
