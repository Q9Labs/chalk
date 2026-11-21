import type { components } from "../generated/screen-annotation-v1";
import type { SpaceClient } from "../space-client";

type Wire = components["schemas"];

export type ScreenAnnotationPoint = Wire["Point"];
export type ScreenAnnotationFrameSize = Wire["FrameSize"];
export type ScreenAnnotationShape = Wire["Shape"];
export type ScreenAnnotationDraft = Wire["Draft"];
export type ScreenAnnotationMark = Wire["Mark"];
export type ScreenAnnotationLayer = Wire["Layer"];
export type ScreenAnnotationState = Wire["State"];
export type ScreenAnnotationCommand = Wire["Command"];
export type ScreenAnnotationCursor = Wire["Cursor"];
export type ScreenAnnotationPresence = Wire["ServerPresence"];

export type ScreenAnnotationTarget = {
  readonly layerId: string;
  readonly fence: number;
};

export type ScreenAnnotationSnapshot =
  | { readonly status: "unavailable" | "connecting" }
  | {
      readonly status: "ready";
      readonly state: ScreenAnnotationState | null;
      readonly presence: readonly ScreenAnnotationPresence[];
    };

export type ScreenAnnotationResult = Wire["ServerReceipt"]["result"] | { readonly kind: "unavailable" } | { readonly kind: "delivery_unknown" };

export interface ScreenAnnotationClient {
  getSnapshot(): ScreenAnnotationSnapshot;
  subscribe(listener: () => void): () => void;
  /** A monotonic estimate on Sync's clock. Use it to interpret expiry times, not for command authority. */
  serverNowMs(): number;
  /** Capture the target at gesture start. Never replace a stale fence on retry. */
  dispatch(target: ScreenAnnotationTarget, command: ScreenAnnotationCommand): Promise<ScreenAnnotationResult>;
  /** A latest-value update, not a command. Pass two nulls to remove this participant's presence. */
  setPresence(target: ScreenAnnotationTarget, cursor: ScreenAnnotationCursor | null, draft: ScreenAnnotationDraft | null): void;
}

const unavailable: ScreenAnnotationSnapshot = { status: "unavailable" };
const unavailableClient: ScreenAnnotationClient = {
  getSnapshot: () => unavailable,
  subscribe: () => () => undefined,
  serverNowMs: Date.now,
  dispatch: async () => ({ kind: "unavailable" }),
  setPresence: () => undefined,
};

const sessions = new WeakMap<SpaceClient, ScreenAnnotationClient>();

/** @internal Registers the controller of a constructed SpaceClient. */
export function registerAnnotationSession(client: SpaceClient, session: ScreenAnnotationClient): void {
  sessions.set(client, session);
}

/** Returns a stable annotation controller; older Sync servers remain unavailable. */
export function screenAnnotationFor(client: SpaceClient): ScreenAnnotationClient {
  return sessions.get(client) ?? unavailableClient;
}
