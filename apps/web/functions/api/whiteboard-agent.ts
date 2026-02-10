import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { convertToModelMessages, streamText, tool, type UIMessage } from "ai";
import { z } from "zod";

type Env = {
	OPENROUTER_API_KEY: string;
	OPENROUTER_DEFAULT_MODEL?: string;
	OPENROUTER_SITE_URL?: string;
	OPENROUTER_APP_NAME?: string;
};

const DEFAULT_MODEL = "moonshotai/kimi-k2.5";

const WhiteboardContextSchema = z
	.object({
		viewport: z.record(z.string(), z.unknown()).optional(),
		selectedElementIds: z.array(z.string()).optional(),
		visibleElements: z
			.array(
				z.object({
					id: z.string(),
					type: z.string(),
					x: z.number().optional(),
					y: z.number().optional(),
					width: z.number().optional(),
					height: z.number().optional(),
					text: z.string().optional(),
				}),
			)
			.optional(),
	})
	.passthrough()
	.optional();

const RequestSchema = z.object({
	messages: z.array(z.unknown()),
	model: z.string().optional(),
	whiteboardContext: WhiteboardContextSchema,
});

const tools = {
	whiteboard_create: tool({
		description:
			"Create new Excalidraw elements. Prefer a few simple shapes + text labels; avoid tiny/overlapping elements.",
		parameters: z.object({
			elements: z.array(z.record(z.string(), z.unknown())).max(50),
			regenerateIds: z.boolean().optional(),
		}),
	}),
	whiteboard_update: tool({
		description:
			"Update existing Excalidraw elements by id. Only provide the fields you want to change.",
		parameters: z.object({
			updates: z
				.array(
					z.object({
						id: z.string(),
						patch: z.record(z.string(), z.unknown()),
					}),
				)
				.max(50),
		}),
	}),
	whiteboard_delete: tool({
		description: "Delete elements by id (soft-delete).",
		parameters: z.object({
			ids: z.array(z.string()).max(100),
		}),
	}),
	whiteboard_select: tool({
		description: "Select elements by id.",
		parameters: z.object({
			ids: z.array(z.string()).max(100),
		}),
	}),
};

const buildSystemPrompt = (whiteboardContext: unknown) => {
	const contextJson =
		whiteboardContext && typeof whiteboardContext === "object"
			? JSON.stringify(whiteboardContext)
			: "{}";

	return [
		"You are a whiteboard agent operating an Excalidraw canvas.",
		"Use tools to make changes. When you need to draw/update/delete/select, call the appropriate tool.",
		"Be conservative: small number of elements, readable labels, aligned layout, avoid clutter.",
		"Do not invent element ids; read ids from the provided context (selection/visibleElements) unless creating new elements.",
		"",
		`Whiteboard context (JSON): ${contextJson}`,
	].join("\n");
};

export const onRequestPost: PagesFunction<Env> = async (context) => {
	const bodyJson = await context.request.json().catch(() => null);
	const parsed = RequestSchema.safeParse(bodyJson);
	if (!parsed.success) {
		return new Response(
			JSON.stringify({ error: "invalid_request", issues: parsed.error.issues }),
			{ status: 400, headers: { "content-type": "application/json" } },
		);
	}

	const { messages, model, whiteboardContext } = parsed.data;

	const apiKey = context.env.OPENROUTER_API_KEY;
	if (!apiKey) {
		return new Response(
			JSON.stringify({
				error: "missing_env",
				message:
					"Missing OPENROUTER_API_KEY. Add it as a Cloudflare Pages secret/env var.",
			}),
			{ status: 500, headers: { "content-type": "application/json" } },
		);
	}

	const referer =
		context.env.OPENROUTER_SITE_URL ??
		new URL(context.request.url).origin ??
		"https://chalk-web.invalid";

	const appName = context.env.OPENROUTER_APP_NAME ?? "Chalk Whiteboard Agent";

	const openrouter = createOpenRouter({
		apiKey,
		headers: {
			"HTTP-Referer": referer,
			"X-Title": appName,
		},
	});

	const modelName = model ?? context.env.OPENROUTER_DEFAULT_MODEL ?? DEFAULT_MODEL;

	const uiMessages = messages as Array<Omit<UIMessage, "id">>;
	const modelMessages = await convertToModelMessages(uiMessages, { tools });

	const result = streamText({
		model: openrouter.chat(modelName),
		system: buildSystemPrompt(whiteboardContext),
		messages: modelMessages,
		tools,
		temperature: 0.2,
	});

	return result.toUIMessageStreamResponse();
};
