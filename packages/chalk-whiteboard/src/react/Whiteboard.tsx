import {
	lazy,
	Suspense,
	useCallback,
	useEffect,
	useRef,
	useState,
	forwardRef,
	useImperativeHandle,
} from "react";
import { SyncEngine } from "../sync-engine";
import type {
	WhiteboardConfig,
	WhiteboardCursor,
	ExcalidrawElement,
	BinaryFiles,
} from "../types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ExcalidrawAPI = any;

// Lazy load Excalidraw (~390KB gzipped)
const Excalidraw = lazy(() =>
	import("@excalidraw/excalidraw").then((mod) => ({ default: mod.Excalidraw })),
);

export interface WhiteboardHandle {
	applyRemoteUpdate: (update: {
		elements: ExcalidrawElement[];
		files?: BinaryFiles;
		seq: number;
	}) => void;
}

export interface WhiteboardProps {
	/** Send WebSocket message function */
	sendMessage: (type: string, payload: unknown) => void;
	/** Whether local user can draw */
	canDraw: boolean;
	/** Initial elements (from snapshot) */
	initialElements?: readonly ExcalidrawElement[];
	/** Initial files (from snapshot) */
	initialFiles?: BinaryFiles;
	/** Remote cursors to display */
	cursors?: Map<string, WhiteboardCursor>;
	/** Called when elements change (for parent state sync) */
	onElementsChange?: (elements: readonly ExcalidrawElement[]) => void;
	/** Sync config */
	config?: WhiteboardConfig;
	/** Additional class name */
	className?: string;
}

export const Whiteboard = forwardRef<WhiteboardHandle, WhiteboardProps>(
	function Whiteboard(
		{
			sendMessage,
			canDraw,
			initialElements = [],
			initialFiles = {},
			onElementsChange,
			config,
			className,
		},
		ref,
	) {
		const [excalidrawAPI, setExcalidrawAPI] = useState<ExcalidrawAPI | null>(
		null,
	);
		const syncEngineRef = useRef<SyncEngine | null>(null);
		const elementsRef = useRef<readonly ExcalidrawElement[]>(initialElements);

		// Initialize sync engine
		useEffect(() => {
			syncEngineRef.current = new SyncEngine(sendMessage, config);
			if (initialElements.length > 0) {
				syncEngineRef.current.loadSnapshot(initialElements, 0);
			}
			return () => {
				syncEngineRef.current?.reset();
			};
		}, [sendMessage, config, initialElements]);

		// Handle local changes - use any for Excalidraw's internal types
		const handleChange = useCallback(
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			(elements: readonly any[], _appState: any, files: any) => {
				if (!canDraw) return;

				elementsRef.current = elements as readonly ExcalidrawElement[];
				onElementsChange?.(elements as readonly ExcalidrawElement[]);
				syncEngineRef.current?.handleChange(
					elements as readonly ExcalidrawElement[],
					files as BinaryFiles,
				);
			},
			[canDraw, onElementsChange],
		);

		// Handle cursor movement
		const handlePointerUpdate = useCallback(
			(payload: { pointer: { x: number; y: number } }) => {
				if (!canDraw) return;
				syncEngineRef.current?.sendCursor(payload.pointer.x, payload.pointer.y);
			},
			[canDraw],
		);

		// Method to apply remote updates (called by parent)
		const applyRemoteUpdate = useCallback(
			(update: {
				elements: ExcalidrawElement[];
				files?: BinaryFiles;
				seq: number;
			}) => {
				if (!syncEngineRef.current || !excalidrawAPI) return;

				const merged = syncEngineRef.current.applyRemoteUpdate(
					elementsRef.current,
					update,
				);
				elementsRef.current = merged;

				excalidrawAPI.updateScene({
					elements: merged,
					...(update.files && { files: update.files }),
				});
			},
			[excalidrawAPI],
		);

		// Expose applyRemoteUpdate via ref
		useImperativeHandle(
			ref,
			() => ({
				applyRemoteUpdate,
			}),
			[applyRemoteUpdate],
		);

		return (
			<div className={className} style={{ width: "100%", height: "100%" }}>
				<Suspense
					fallback={
						<div className="flex items-center justify-center h-full bg-gray-900 text-white">
							Loading whiteboard...
						</div>
					}
				>
					<Excalidraw
						excalidrawAPI={(api: ExcalidrawAPI) => setExcalidrawAPI(api)}
						// Cast to any to bypass Excalidraw's internal type checks
						// eslint-disable-next-line @typescript-eslint/no-explicit-any
						initialData={{
							elements: initialElements as any,
							files: initialFiles as any,
							appState: {
								viewBackgroundColor: "#1a1a2e",
								theme: "dark",
							},
						} as any}
						onChange={handleChange}
						onPointerUpdate={handlePointerUpdate}
						viewModeEnabled={!canDraw}
						UIOptions={{
							canvasActions: {
								changeViewBackgroundColor: canDraw,
								clearCanvas: canDraw,
								export: {},
								loadScene: false,
								saveToActiveFile: false,
								toggleTheme: false,
							},
						}}
					/>
				</Suspense>
			</div>
		);
	},
);
