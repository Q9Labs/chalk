import { sessionBaggage } from "../session";
import type { WhiteboardV1ClientFrame } from "../generated/whiteboard-v1";

const VIEW_WITH_OWNER = { name: "view_v1", origins: true, owner: true } as const;
const DRAW_POLICY = { name: "draw_policy_v1" } as const;
const PRESENTER_VIEW_EXTENSIONS = [{ name: "presentation_v1", presenter: true }, VIEW_WITH_OWNER, DRAW_POLICY] as const;
/** A hello with no extensions, the only one the oldest Sync servers accept. */
export const BARE_HELLO = { name: "bare", views: false, origins: false, drawPolicy: false, extensions: [] } as const;
// Older Sync servers close an unknown hello, so the client steps down this list.
const HELLO_LEVELS = [
  { name: "session", views: true, origins: true, drawPolicy: true, extensions: PRESENTER_VIEW_EXTENSIONS },
  { name: "presenter-view", views: true, origins: true, drawPolicy: true, extensions: PRESENTER_VIEW_EXTENSIONS },
  { name: "owner-view", views: true, origins: true, drawPolicy: true, extensions: [{ name: "presentation_v1" }, VIEW_WITH_OWNER, DRAW_POLICY] },
  { name: "draw-policy", views: true, origins: true, drawPolicy: true, extensions: [{ name: "presentation_v1" }, { name: "view_v1", origins: true }, DRAW_POLICY] },
  { name: "versioned-view", views: true, origins: true, drawPolicy: false, extensions: [{ name: "presentation_v1" }, { name: "view_v1", origins: true }] },
  { name: "view", views: true, origins: false, drawPolicy: false, extensions: [{ name: "presentation_v1" }, { name: "view_v1" }] },
  { name: "presentation", views: false, origins: false, drawPolicy: false, extensions: [{ name: "presentation_v1" }] },
  BARE_HELLO,
] as const;
export type HelloLevel = (typeof HELLO_LEVELS)[number];

export const FIRST_HELLO = HELLO_LEVELS[0];

/** The level after this one. A session hello with no baggage equals the presenter-view one, so it skips that rung. */
export function nextHelloLevel(level: HelloLevel): HelloLevel {
  const step = level.name === "session" && sessionBaggage() === undefined ? 2 : 1;
  return HELLO_LEVELS[Math.min(HELLO_LEVELS.indexOf(level) + step, HELLO_LEVELS.length - 1)] ?? BARE_HELLO;
}

export function helloFrame(level: HelloLevel, token: string, cursor: { readonly scene_id: string; readonly revision: string } | null): WhiteboardV1ClientFrame {
  const hello = { type: "hello", protocol: "whiteboard-v1", token, cursor } as const;
  if (level === BARE_HELLO) return hello;
  const baggage = level.name === "session" ? sessionBaggage() : undefined;
  const withExtensions = { ...hello, extensions: level.extensions };
  return baggage === undefined ? withExtensions : { ...withExtensions, baggage };
}
