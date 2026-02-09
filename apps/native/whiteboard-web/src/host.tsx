import { Excalidraw } from "@excalidraw/excalidraw";
import type { AppState, BinaryFiles, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ExcalidrawCollabEngine } from "@q9labs/chalk-whiteboard/collab";

type BridgeEnvelope = { type: string; payload?: any; requestId?: string };

const postToNative = (env: BridgeEnvelope) => {
	const json = JSON.stringify(env);
	const bridge = (globalThis as any).ChalkNativeBridge;
	if (bridge?.postMessage) return bridge.postMessage(json);
	const wk = (globalThis as any).webkit?.messageHandlers?.chalk;
	if (wk?.postMessage) return wk.postMessage(json);
	console.log("no native bridge; dropping message", env.type);
};

const uuid = () => {
	if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
	return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

const WhiteboardHost = () => {
	const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
	const engineRef = useRef<any>(null);

	const [canDraw, setCanDraw] = useState(true);
	const [theme, setTheme] = useState<"light" | "dark">("dark");

	const pending = useRef(
		new Map<
			string,
			{
				resolve: (value: any) => void;
				reject: (err: Error) => void;
			}
		>(),
	);

	const initialData = useMemo(
		() => ({
			appState: {
				theme,
				viewBackgroundColor: theme === "dark" ? "#000" : "#fff",
			} satisfies Partial<AppState>,
		}),
		[theme],
	);

	useEffect(() => {
		(globalThis as any).__chalkNativeOnMessage = (raw: string) => {
			let env: BridgeEnvelope | null = null;
			try {
				env = JSON.parse(raw);
			} catch {
				return;
			}

			const eng = engineRef.current;
			if (!env) return;

			switch (env.type) {
				case "wb.init": {
					if (typeof env.payload?.canDraw === "boolean") setCanDraw(env.payload.canDraw);
					if (env.payload?.theme === "light" || env.payload?.theme === "dark") setTheme(env.payload.theme);
					eng?.setCanDraw?.(!!env.payload?.canDraw);
					return;
				}
				case "wb.snapshot": {
					eng?.handleRemoteSnapshot?.({
						sceneId: env.payload?.sceneId,
						elements: env.payload?.elements ?? [],
					});
					return;
				}
				case "wb.update": {
					eng?.handleRemoteData?.({
						sceneId: env.payload?.sceneId,
						syncAll: env.payload?.syncAll,
						elements: env.payload?.elements ?? [],
					});
					return;
				}
				case "wb.cursor": {
					eng?.handleRemoteCursor?.({
						participantId: env.payload?.participantId,
						displayName: env.payload?.displayName,
						x: env.payload?.x,
						y: env.payload?.y,
						timestamp: new Date(env.payload?.timestampIso ?? Date.now()),
					});
					return;
				}
				case "wb.presignUpload.result":
				case "wb.presignDownload.result": {
					const reqId = env.requestId;
					if (!reqId) return;
					const p = pending.current.get(reqId);
					if (!p) return;
					pending.current.delete(reqId);
					if (env.payload?.error) p.reject(new Error(String(env.payload.error)));
					else p.resolve(env.payload);
					return;
				}
				default:
					return;
			}
		};
	}, []);

	useEffect(() => {
		const api = apiRef.current;
		if (!api || engineRef.current) return;

		engineRef.current = new ExcalidrawCollabEngine({
			excalidrawAPI: api,
			canDraw,
			sendUpdateV2: (payload: any) => postToNative({ type: "wb.sendUpdateV2", payload }),
			sendCursor: (payload: any) => postToNative({ type: "wb.sendCursor", payload }),
			requestSync: () => postToNative({ type: "wb.requestSync" }),
			sendClear: () => postToNative({ type: "wb.sendClear" }),
			presignUpload: async (fileId: string, mimeType: string) => {
				const requestId = uuid();
				const p = new Promise<{ uploadUrl: string }>((resolve, reject) => {
					pending.current.set(requestId, { resolve, reject });
				});
				postToNative({ type: "wb.presignUpload", requestId, payload: { fileId, mimeType } });
				return await p;
			},
			presignDownload: async (fileId: string) => {
				const requestId = uuid();
				const p = new Promise<{ downloadUrl: string }>((resolve, reject) => {
					pending.current.set(requestId, { resolve, reject });
				});
				postToNative({ type: "wb.presignDownload", requestId, payload: { fileId } });
				return await p;
			},
		});
	}, [canDraw]);

	return (
		<Excalidraw
			excalidrawAPI={(api) => {
				apiRef.current = api as ExcalidrawImperativeAPI;
			}}
			isCollaborating
			theme={theme}
			initialData={initialData as any}
			viewModeEnabled={!canDraw}
			onChange={(elements: readonly unknown[], appState: AppState, files: BinaryFiles) => {
				engineRef.current?.handleChange?.(elements as any, appState as any, files as any);
			}}
			onPointerUpdate={(payload: any) => engineRef.current?.handlePointerUpdate?.(payload)}
		/>
	);
};

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("missing #root");
createRoot(rootEl).render(<WhiteboardHost />);
