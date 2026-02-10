import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { useChat } from "@ai-sdk/react";
import {
	DefaultChatTransport,
	lastAssistantMessageIsCompleteWithToolCalls,
} from "ai";
import { useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { useWhiteboard } from "@q9labs/chalk-react";

type Props = {
	excalidrawAPI: ExcalidrawImperativeAPI | null;
};

const DEFAULT_MODEL = "moonshotai/kimi-k2.5";

const MODEL_OPTIONS = [
	{ value: "moonshotai/kimi-k2.5", label: "Kimi K2.5" },
	{ value: "openai/gpt-4o-mini", label: "GPT-4o mini" },
	{ value: "anthropic/claude-3.5-sonnet", label: "Claude 3.5 Sonnet" },
	{ value: "google/gemini-2.0-flash", label: "Gemini 2.0 Flash" },
];

const ALLOWED_PATCH_KEYS = new Set([
	"x",
	"y",
	"width",
	"height",
	"angle",
	"text",
	"strokeColor",
	"backgroundColor",
	"opacity",
	"fontSize",
	"fontFamily",
	"textAlign",
	"verticalAlign",
	"roundness",
	"strokeWidth",
	"roughness",
	"fillStyle",
	"locked",
]);

let excalidrawLibPromise:
	| Promise<typeof import("@excalidraw/excalidraw")>
	| null = null;

const loadExcalidrawLib = () =>
	(excalidrawLibPromise ??= import("@excalidraw/excalidraw"));

const summarizeElements = (elements: readonly any[]) =>
	elements
		.filter((el) => el && !el.isDeleted)
		.slice(0, 60)
		.map((el) => ({
			id: String(el.id),
			type: String(el.type),
			x: typeof el.x === "number" ? el.x : undefined,
			y: typeof el.y === "number" ? el.y : undefined,
			width: typeof el.width === "number" ? el.width : undefined,
			height: typeof el.height === "number" ? el.height : undefined,
			text: typeof el.text === "string" ? el.text.slice(0, 200) : undefined,
		}));

const buildWhiteboardContext = (api: ExcalidrawImperativeAPI) => {
	const appState = api.getAppState() as any;
	const selectedElementIds = Object.keys(appState?.selectedElementIds ?? {}).filter(
		(id) => !!id && appState.selectedElementIds[id],
	);
	const elements = api.getSceneElementsIncludingDeleted() as any[];

	return {
		viewport:
			appState && typeof appState === "object"
				? {
						scrollX: appState.scrollX,
						scrollY: appState.scrollY,
						zoom: appState.zoom?.value ?? appState.zoom,
					}
				: undefined,
		selectedElementIds,
		visibleElements: summarizeElements(elements),
	};
};

const pickPatch = (patch: Record<string, unknown>) => {
	const next: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(patch)) {
		if (!ALLOWED_PATCH_KEYS.has(key)) continue;
		next[key] = value;
	}
	return next;
};

export function WhiteboardAgentOverlay({ excalidrawAPI }: Props) {
	const { isOpen: isWhiteboardOpen } = useWhiteboard();
	const excalidrawApiRef = useRef<ExcalidrawImperativeAPI | null>(null);
	excalidrawApiRef.current = excalidrawAPI;
	const [isPanelOpen, setIsPanelOpen] = useState(false);
	const [input, setInput] = useState("");
	const [model, setModel] = useState(DEFAULT_MODEL);

	const transport = useMemo(
		() =>
			new DefaultChatTransport({
				api: "/api/whiteboard-agent",
			}),
		[],
	);

	const { messages, sendMessage, addToolOutput, status, error } = useChat({
		transport,
		sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
		async onToolCall({ toolCall }) {
			if (toolCall.dynamic) return;
			const api = excalidrawApiRef.current;
			if (!api) return;

			try {
				const { CaptureUpdateAction, convertToExcalidrawElements, newElementWith } =
					await loadExcalidrawLib();

				switch (toolCall.toolName) {
					case "whiteboard_create": {
						const elements = api.getSceneElementsIncludingDeleted() as any[];
						const created = convertToExcalidrawElements(
							toolCall.args.elements as any,
							{
								regenerateIds: toolCall.args.regenerateIds ?? true,
							},
						);

						api.updateScene({
							elements: [...elements, ...created] as any,
							captureUpdate: CaptureUpdateAction.IMMEDIATELY,
						});

						addToolOutput({
							tool: "whiteboard_create",
							toolCallId: toolCall.toolCallId,
							output: { ok: true, created: created.length },
						});
						return;
					}

					case "whiteboard_update": {
						const elements = api.getSceneElementsIncludingDeleted() as any[];
						const updates = toolCall.args.updates as Array<{
							id: string;
							patch: Record<string, unknown>;
						}>;

						const patchById = new Map(
							(updates ?? []).map((u) => [String(u.id), pickPatch(u.patch ?? {})]),
						);

						let changed = 0;
						const next = elements.map((el) => {
							const patch = patchById.get(String(el?.id));
							if (!patch || el?.isDeleted) return el;
							changed += 1;
							return newElementWith(el, patch as any);
						});

						if (changed > 0) {
							api.updateScene({
								elements: next as any,
								captureUpdate: CaptureUpdateAction.IMMEDIATELY,
							});
						}

						addToolOutput({
							tool: "whiteboard_update",
							toolCallId: toolCall.toolCallId,
							output: { ok: true, updated: changed },
						});
						return;
					}

					case "whiteboard_delete": {
						const elements = api.getSceneElementsIncludingDeleted() as any[];
						const ids = new Set((toolCall.args.ids as string[]).map(String));

						let deleted = 0;
						const next = elements.map((el) => {
							if (!el || el.isDeleted) return el;
							if (!ids.has(String(el.id))) return el;
							deleted += 1;
							return newElementWith(el, { isDeleted: true } as any);
						});

						if (deleted > 0) {
							api.updateScene({
								elements: next as any,
								captureUpdate: CaptureUpdateAction.IMMEDIATELY,
							});
						}

						addToolOutput({
							tool: "whiteboard_delete",
							toolCallId: toolCall.toolCallId,
							output: { ok: true, deleted },
						});
						return;
					}

					case "whiteboard_select": {
						const ids = (toolCall.args.ids as string[]).map(String);
						const selectedElementIds = Object.fromEntries(
							ids.map((id) => [id, true]),
						);

						api.updateScene({
							appState: { selectedElementIds } as any,
							captureUpdate: CaptureUpdateAction.NEVER,
						});

						addToolOutput({
							tool: "whiteboard_select",
							toolCallId: toolCall.toolCallId,
							output: { ok: true, selected: ids.length },
						});
						return;
					}
				}
			} catch (e) {
				addToolOutput({
					tool: toolCall.toolName as any,
					toolCallId: toolCall.toolCallId,
					output: { ok: false, error: e instanceof Error ? e.message : String(e) },
				});
			}
		},
	});

	if (!isWhiteboardOpen) return null;

	return (
		<div className="absolute right-4 bottom-4 z-50 pointer-events-none">
			<div className="pointer-events-auto flex items-end gap-2">
				{isPanelOpen && (
					<div className="w-[420px] h-[520px] rounded-2xl border border-white/10 bg-zinc-950/70 backdrop-blur-xl shadow-2xl overflow-hidden flex flex-col">
						<div className="px-3 py-2 border-b border-white/10 flex items-center gap-2">
							<div className="text-sm font-medium text-white/90">
								Whiteboard Agent
							</div>
							<div className="ml-auto flex items-center gap-2">
								<select
									value={model}
									onChange={(e) => setModel(e.target.value)}
									className="h-8 rounded-md bg-black/40 border border-white/10 text-white/80 text-xs px-2 outline-none"
									title="Model"
								>
									{MODEL_OPTIONS.map((opt) => (
										<option key={opt.value} value={opt.value}>
											{opt.label}
										</option>
									))}
								</select>
								<button
									type="button"
									onClick={() => setIsPanelOpen(false)}
									className="h-8 px-2 rounded-md text-white/70 hover:text-white hover:bg-white/10"
								>
									Close
								</button>
							</div>
						</div>

						<div className="flex-1 overflow-auto p-3 space-y-3">
							{messages.map((m) => (
								<div key={m.id} className="space-y-1">
									<div
										className={cn(
											"text-[11px] uppercase tracking-wide",
											m.role === "user" ? "text-white/50" : "text-teal-200/70",
										)}
									>
										{m.role}
									</div>
									<div className="text-sm text-white/90 whitespace-pre-wrap">
										{m.parts
											.map((p: any) => (p.type === "text" ? p.text : ""))
											.join("")}
									</div>
								</div>
							))}

							{error && (
								<div className="text-sm text-red-300">
									{error.message ?? String(error)}
								</div>
							)}
						</div>

						<form
							className="p-3 border-t border-white/10 flex gap-2"
							onSubmit={(e) => {
								e.preventDefault();
								if (!input.trim() || !excalidrawAPI) return;

								const whiteboardContext = buildWhiteboardContext(excalidrawAPI);

								sendMessage(
									{ text: input },
									{
										body: {
											model,
											whiteboardContext,
										},
									},
								);
								setInput("");
							}}
						>
							<input
								value={input}
								onChange={(e) => setInput(e.target.value)}
								placeholder="Describe what to draw or change..."
								className="flex-1 h-10 rounded-xl bg-black/40 border border-white/10 text-white/90 placeholder:text-white/40 px-3 outline-none"
							/>
							<button
								type="submit"
								disabled={status !== "ready"}
								className="h-10 px-4 rounded-xl bg-teal-500/90 hover:bg-teal-500 text-black font-medium disabled:opacity-50 disabled:cursor-not-allowed"
							>
								{status === "ready" ? "Send" : "…"}
							</button>
						</form>
					</div>
				)}

				<button
					type="button"
					onClick={() => setIsPanelOpen((v) => !v)}
					className="h-10 px-4 rounded-xl bg-black/50 backdrop-blur-xl border border-white/10 text-white/80 hover:text-white hover:bg-black/70 shadow-lg"
				>
					{isPanelOpen ? "Hide agent" : "Agent"}
				</button>
			</div>
		</div>
	);
}
