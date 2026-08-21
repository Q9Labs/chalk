/**
 * The URL contract for the development SDK preview gallery.
 *
 * The gallery is intentionally driven by a small, serializable value object:
 * every state can be opened directly, copied into a bug report, and restored
 * after a reload without depending on React state.
 */

import { THEME_SKINS, type ThemeSkin } from "../../../../../sdks/typescript/react/src/components/theme";

export const PREVIEW_VIEWS = ["entrance", "space"] as const;
export type PreviewView = (typeof PREVIEW_VIEWS)[number];

export const ENTRANCE_STATES = ["ready", "joining", "waiting", "warning", "timeout", "failure"] as const;
export type EntranceState = (typeof ENTRANCE_STATES)[number];

export const SPACE_STATES = ["happy", "empty", "warning", "reconnecting", "retry", "confirmation", "timeout", "failure", "ended"] as const;
export type SpaceState = (typeof SPACE_STATES)[number];

export type PreviewState = EntranceState | SpaceState;

export const PREVIEW_LAYOUTS = ["focus", "grid", "presentation"] as const;
export type PreviewLayout = (typeof PREVIEW_LAYOUTS)[number];

export const PREVIEW_PANELS = ["none", "chat", "participants", "transcript", "admission"] as const;
export type PreviewPanel = (typeof PREVIEW_PANELS)[number];

export const PREVIEW_STAGES = ["people", "share", "whiteboard"] as const;
export type PreviewStage = (typeof PREVIEW_STAGES)[number];

export const PREVIEW_DIALOGS = ["none", "info", "settings", "invite"] as const;
export type PreviewDialog = (typeof PREVIEW_DIALOGS)[number];

export const PREVIEW_PALETTES = ["warm-charcoal", "midnight", "slate", "paper", "cosmic"] as const;
export type PreviewPalette = (typeof PREVIEW_PALETTES)[number];

export const PREVIEW_TEXTURES = ["soft-grid", "soft-dots", "none"] as const;
export type PreviewTexture = (typeof PREVIEW_TEXTURES)[number];

export const PREVIEW_SKINS = THEME_SKINS.map((skin) => skin.value);
export type PreviewSkin = ThemeSkin;

const PREVIEW_CHROME = ["visible", "hidden"] as const;
export type PreviewChrome = (typeof PREVIEW_CHROME)[number];

export const PREVIEW_PARTICIPANT_COUNTS = [0, 1, 2, 5, 9, 12] as const;
export type PreviewParticipants = (typeof PREVIEW_PARTICIPANT_COUNTS)[number];

export const PREVIEW_CHAT_STATES = ["ready", "empty", "loading", "failure", "pending"] as const;
export type PreviewChat = (typeof PREVIEW_CHAT_STATES)[number];

export const PREVIEW_TOASTS = ["none", "info", "success", "warning", "error"] as const;
export type PreviewToast = (typeof PREVIEW_TOASTS)[number];

export interface PreviewSearch {
  readonly view: PreviewView;
  readonly state: PreviewState;
  readonly layout: PreviewLayout;
  readonly panel: PreviewPanel;
  readonly stage: PreviewStage;
  readonly dialog: PreviewDialog;
  readonly skin: PreviewSkin;
  readonly palette: PreviewPalette;
  readonly texture: PreviewTexture;
  readonly chrome: PreviewChrome;
  readonly participants: PreviewParticipants;
  readonly chat: PreviewChat;
  readonly mic: boolean;
  readonly camera: boolean;
  readonly hand: boolean;
  readonly toast: PreviewToast;
}

export type PreviewSearchPatch = Partial<PreviewSearch>;

export const DEFAULT_PREVIEW_SEARCH: PreviewSearch = {
  view: "entrance",
  state: "ready",
  layout: "focus",
  panel: "none",
  stage: "people",
  dialog: "none",
  skin: "classic",
  palette: "warm-charcoal",
  texture: "soft-grid",
  chrome: "visible",
  participants: 2,
  chat: "ready",
  mic: true,
  camera: true,
  hand: false,
  toast: "none",
};

export interface PreviewSerializeOptions {
  /** Keep values equal to their defaults when a complete query is useful. */
  readonly includeDefaults?: boolean;
}

type PreviewSearchSource = URLSearchParams | URL | string | Readonly<Record<string, unknown>>;
type PreviewSearchLike = PreviewSearchSource | PreviewSearchPatch;

const SEARCH_KEYS = ["view", "state", "layout", "panel", "stage", "dialog", "skin", "palette", "texture", "chrome", "participants", "chat", "mic", "camera", "hand", "toast"] as const;

function sourceValue(source: PreviewSearchSource | PreviewSearchPatch, key: string): unknown {
  if (source instanceof URLSearchParams) return source.get(key) ?? undefined;
  if (source instanceof URL) return source.searchParams.get(key) ?? undefined;

  if (typeof source === "string") {
    const query = source.includes("?") ? source.slice(source.indexOf("?") + 1).split("#", 1)[0] : source.replace(/^\?/, "");
    return new URLSearchParams(query).get(key) ?? undefined;
  }

  const value = source[key as keyof typeof source];
  return Array.isArray(value) ? value[0] : value;
}

function enumValue<T extends readonly string[]>(value: unknown, values: T, fallback: T[number]): T[number] {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  return (values as readonly string[]).includes(normalized) ? (normalized as T[number]) : fallback;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && (value === 0 || value === 1)) return value === 1;
  if (typeof value !== "string") return fallback;

  switch (value.trim().toLowerCase()) {
    case "true":
    case "1":
    case "yes":
    case "on":
      return true;
    case "false":
    case "0":
    case "no":
    case "off":
      return false;
    default:
      return fallback;
  }
}

function participantCount(value: unknown): PreviewParticipants {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return DEFAULT_PREVIEW_SEARCH.participants;
  if ((PREVIEW_PARTICIPANT_COUNTS as readonly number[]).includes(parsed)) return parsed as PreviewParticipants;

  return PREVIEW_PARTICIPANT_COUNTS.reduce((nearest, candidate) => (Math.abs(candidate - parsed) < Math.abs(nearest - parsed) ? candidate : nearest), PREVIEW_PARTICIPANT_COUNTS[0]);
}

function stateValues(view: PreviewView): readonly [PreviewState, ...PreviewState[]] {
  return view === "entrance" ? ENTRANCE_STATES : SPACE_STATES;
}

function defaultState(view: PreviewView): EntranceState | SpaceState {
  return view === "entrance" ? "ready" : "happy";
}

/** Normalize any route/search input into the complete typed contract. */
export function normalizePreviewSearch(source: PreviewSearchLike = {}): PreviewSearch {
  const view = enumValue(sourceValue(source, "view"), PREVIEW_VIEWS, DEFAULT_PREVIEW_SEARCH.view);
  const state = enumValue(sourceValue(source, "state"), stateValues(view), defaultState(view));

  return {
    view,
    state,
    layout: enumValue(sourceValue(source, "layout"), PREVIEW_LAYOUTS, DEFAULT_PREVIEW_SEARCH.layout),
    panel: enumValue(sourceValue(source, "panel"), PREVIEW_PANELS, DEFAULT_PREVIEW_SEARCH.panel),
    stage: enumValue(sourceValue(source, "stage"), PREVIEW_STAGES, DEFAULT_PREVIEW_SEARCH.stage),
    dialog: enumValue(sourceValue(source, "dialog"), PREVIEW_DIALOGS, DEFAULT_PREVIEW_SEARCH.dialog),
    skin: enumValue(sourceValue(source, "skin"), PREVIEW_SKINS, DEFAULT_PREVIEW_SEARCH.skin),
    palette: enumValue(sourceValue(source, "palette"), PREVIEW_PALETTES, DEFAULT_PREVIEW_SEARCH.palette),
    texture: enumValue(sourceValue(source, "texture"), PREVIEW_TEXTURES, DEFAULT_PREVIEW_SEARCH.texture),
    chrome: enumValue(sourceValue(source, "chrome"), PREVIEW_CHROME, DEFAULT_PREVIEW_SEARCH.chrome),
    participants: participantCount(sourceValue(source, "participants")),
    chat: enumValue(sourceValue(source, "chat"), PREVIEW_CHAT_STATES, DEFAULT_PREVIEW_SEARCH.chat),
    mic: booleanValue(sourceValue(source, "mic"), DEFAULT_PREVIEW_SEARCH.mic),
    camera: booleanValue(sourceValue(source, "camera"), DEFAULT_PREVIEW_SEARCH.camera),
    hand: booleanValue(sourceValue(source, "hand"), DEFAULT_PREVIEW_SEARCH.hand),
    toast: enumValue(sourceValue(source, "toast"), PREVIEW_TOASTS, DEFAULT_PREVIEW_SEARCH.toast),
  };
}

export const parsePreviewSearch = normalizePreviewSearch;

function differsFromDefault(key: keyof PreviewSearch, value: PreviewSearch[keyof PreviewSearch], search: PreviewSearch): boolean {
  if (key === "state") return value !== defaultState(search.view);
  return value !== DEFAULT_PREVIEW_SEARCH[key];
}

/** Serialize a normalized search in a stable key order with minimal defaults. */
export function serializePreviewSearch(source: PreviewSearchLike = {}, options: PreviewSerializeOptions = {}): string {
  const search = normalizePreviewSearch(source);
  const params = new URLSearchParams();
  const includeDefaults = options.includeDefaults === true;

  for (const key of SEARCH_KEYS) {
    const value = search[key];
    if (!includeDefaults && !differsFromDefault(key, value, search)) continue;
    params.set(key, String(value));
  }

  return params.toString();
}

/** Update only the supplied typed values, preserving all current search state. */
export function patchPreviewSearch(current: PreviewSearchLike, updates: PreviewSearchPatch): PreviewSearch {
  const merged: Record<string, unknown> = {};
  for (const key of SEARCH_KEYS) {
    const currentValue = sourceValue(current, key);
    const nextValue = updates[key];
    merged[key] = nextValue === undefined ? currentValue : nextValue;
  }
  return normalizePreviewSearch(merged);
}

/** Return a deterministic `/sdk-preview` URL for a complete or partial search. */
export function createPreviewHref(search: PreviewSearchLike = {}, base = "/sdk-preview"): string {
  const hashIndex = base.indexOf("#");
  const hash = hashIndex >= 0 ? base.slice(hashIndex) : "";
  const path = (hashIndex >= 0 ? base.slice(0, hashIndex) : base).split("?", 1)[0] ?? "/sdk-preview";
  const query = serializePreviewSearch(search);
  return `${path || "/sdk-preview"}${query ? `?${query}` : ""}${hash}`;
}
