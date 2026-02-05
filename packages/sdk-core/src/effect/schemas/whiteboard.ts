import { Schema } from "@effect/schema";
import type { AppState } from "@q9labs/chalk-whiteboard";

const isObject = (input: unknown): input is Record<string, unknown> =>
	typeof input === "object" && input !== null && !Array.isArray(input);

// Excalidraw appState is a wide, evolving object. Validate as an object while
// keeping the full AppState type sourced from Excalidraw.
export const AppStateSchema = Schema.declare(
	(input): input is AppState => isObject(input),
);

// For outbound deltas we often send partial appState.
export const AppStatePartialSchema = Schema.declare(
	(input): input is Partial<AppState> => isObject(input),
);
