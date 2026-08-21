/**
 * The serializable URL contract for the development SDK preview gallery.
 *
 * This module is deliberately free of React and browser state. The route can
 * therefore validate, copy, and restore every preview combination from a URL.
 */

import type { Capability } from "@q9labsai/chalk-client";
import { THEME_PALETTES, THEME_SKINS, THEME_TEXTURES, type ThemePalette, type ThemeSkin, type ThemeTexture } from "../../../../../sdks/typescript/react/src/components/theme";
import type { SpaceViewFeatures } from "../../../../../sdks/typescript/react/src/components/space-view/SpaceView";

export const PREVIEW_VIEWS = ["entrance", "space"] as const;
export type PreviewView = (typeof PREVIEW_VIEWS)[number];

export const ENTRANCE_STATES = ["ready", "joining", "waiting", "warning", "timeout", "failure"] as const;
export type EntranceState = (typeof ENTRANCE_STATES)[number];

/** `failure` is the post-live failed status surface; `reconnecting` remains recoverable. */
export const SPACE_STATES = ["happy", "empty", "warning", "reconnecting", "retry", "confirmation", "timeout", "failure", "leaving", "left", "ended"] as const;
export type SpaceState = (typeof SPACE_STATES)[number];

export type PreviewState = EntranceState | SpaceState;

export const PREVIEW_LAYOUTS = ["focus", "grid", "presentation"] as const;
export type PreviewLayout = (typeof PREVIEW_LAYOUTS)[number];

export const PREVIEW_PANELS = ["none", "chat", "participants"] as const;
export type PreviewPanel = (typeof PREVIEW_PANELS)[number];

export const PREVIEW_STAGES = ["people", "share", "whiteboard"] as const;
export type PreviewStage = (typeof PREVIEW_STAGES)[number];

export const PREVIEW_DIALOGS = ["none", "info", "settings", "invite"] as const;
export type PreviewDialog = (typeof PREVIEW_DIALOGS)[number];

/** Appearance values are copied directly from the SDK theme constants. */
export const PREVIEW_PALETTES: readonly ThemePalette[] = THEME_PALETTES.map((palette) => palette.value);
export type PreviewPalette = ThemePalette;

export const PREVIEW_TEXTURES: readonly ThemeTexture[] = THEME_TEXTURES.map((texture) => texture.value);
export type PreviewTexture = ThemeTexture;

export const PREVIEW_SKINS: readonly ThemeSkin[] = THEME_SKINS.map((skin) => skin.value);
export type PreviewSkin = ThemeSkin;

export const PREVIEW_MEDIA_STATES = ["unavailable", "requesting", "enabled", "disabled", "failed"] as const;
export type PreviewMediaState = (typeof PREVIEW_MEDIA_STATES)[number];

export const PREVIEW_ACTIVE_SPEAKERS = ["none", "you", "nora", "akash", "sofia", "malik", "priya", "eli", "june", "tomas", "lena", "kenji", "amara"] as const;
export type PreviewActiveSpeaker = (typeof PREVIEW_ACTIVE_SPEAKERS)[number];

export const PREVIEW_SCREEN_SHARES = ["none", "local", "remote"] as const;
export type PreviewScreenShare = (typeof PREVIEW_SCREEN_SHARES)[number];

export const PREVIEW_INCOMING_MEDIA_REQUESTS = ["none", "unmute", "start-camera"] as const;
export type PreviewIncomingMediaRequest = (typeof PREVIEW_INCOMING_MEDIA_REQUESTS)[number];

export const PREVIEW_ADMISSION_QUEUES = ["empty", "waiting"] as const;
export type PreviewAdmissionQueue = (typeof PREVIEW_ADMISSION_QUEUES)[number];

export const PREVIEW_ROLE_PRESETS = ["owner", "collaborator", "observer"] as const;
export type PreviewRolePreset = (typeof PREVIEW_ROLE_PRESETS)[number];

export const PREVIEW_CAPABILITY_PRESETS = ["full", "collaborator", "observer", "none"] as const;
export type PreviewCapabilityPreset = (typeof PREVIEW_CAPABILITY_PRESETS)[number];

/** Keep this list synchronized with the SDK's SpaceViewFeatures interface. */
export const PREVIEW_FEATURE_KEYS = ["chat", "participants", "admission", "screenShare", "whiteboard", "reactions", "handRaise", "info", "settings", "sounds"] as const satisfies readonly (keyof SpaceViewFeatures)[];
export type PreviewFeatureKey = (typeof PREVIEW_FEATURE_KEYS)[number];
export type PreviewFeatures = { readonly [Key in PreviewFeatureKey]: boolean };

const PREVIEW_CHROME = ["visible", "hidden"] as const;
export type PreviewChrome = (typeof PREVIEW_CHROME)[number];

export const PREVIEW_PARTICIPANT_COUNTS = [0, 1, 2, 5, 9, 12] as const;
export type PreviewParticipants = (typeof PREVIEW_PARTICIPANT_COUNTS)[number];

export const PREVIEW_CHAT_STATES = ["ready", "empty", "loading", "failure", "pending"] as const;
export type PreviewChat = (typeof PREVIEW_CHAT_STATES)[number];

export const PREVIEW_TOASTS = ["none", "info", "success", "warning", "error"] as const;
export type PreviewToast = (typeof PREVIEW_TOASTS)[number];

const ALL_CAPABILITIES: readonly Capability[] = [
  "publishAudio",
  "publishVideo",
  "publishScreen",
  "subscribe",
  "raiseHand",
  "renameSelf",
  "sendChat",
  "sendReaction",
  "drawWhiteboard",
  "manageWhiteboard",
  "manageAdmission",
  "assignRoles",
  "muteOthers",
  "stopVideoOthers",
  "stopScreenOthers",
  "requestMediaOthers",
  "removeParticipant",
  "manageRecording",
  "startEpisode",
  "extendEpisode",
  "endEpisode",
  "manageMembers",
  "clearSpaceContent",
];

const COLLABORATOR_CAPABILITIES: readonly Capability[] = ["publishAudio", "publishVideo", "publishScreen", "subscribe", "raiseHand", "renameSelf", "sendChat", "sendReaction", "drawWhiteboard", "manageWhiteboard"];

const OBSERVER_CAPABILITIES: readonly Capability[] = ["subscribe"];

export const PREVIEW_CAPABILITIES: Readonly<Record<PreviewCapabilityPreset, readonly Capability[]>> = {
  full: ALL_CAPABILITIES,
  collaborator: COLLABORATOR_CAPABILITIES,
  observer: OBSERVER_CAPABILITIES,
  none: [],
};

const DEFAULT_PREVIEW_FEATURES: PreviewFeatures = {
  chat: true,
  participants: true,
  admission: true,
  screenShare: true,
  whiteboard: true,
  reactions: true,
  handRaise: true,
  info: true,
  settings: true,
  sounds: true,
};

export interface PreviewSearch {
  readonly view: PreviewView;
  readonly state: PreviewState;
  readonly layout: PreviewLayout;
  readonly panel: PreviewPanel;
  readonly stage: PreviewStage;
  readonly stageBackground: boolean;
  readonly dialog: PreviewDialog;
  readonly skin: PreviewSkin;
  readonly palette: PreviewPalette;
  readonly texture: PreviewTexture;
  readonly chrome: PreviewChrome;
  readonly participants: PreviewParticipants;
  readonly chat: PreviewChat;
  readonly mic: PreviewMediaState;
  readonly camera: PreviewMediaState;
  readonly hand: boolean;
  readonly activeSpeaker: PreviewActiveSpeaker;
  readonly screenShare: PreviewScreenShare;
  readonly incomingMediaRequest: PreviewIncomingMediaRequest;
  readonly admissionQueue: PreviewAdmissionQueue;
  readonly diagnostics: boolean;
  readonly role: PreviewRolePreset;
  readonly capability: PreviewCapabilityPreset;
  readonly features: PreviewFeatures;
  readonly toast: PreviewToast;
}

type PreviewScalar = string | number | boolean;
type PreviewQueryValue = PreviewScalar | readonly PreviewScalar[];

interface PreviewFeatureInput {
  readonly chat?: PreviewQueryValue;
  readonly participants?: PreviewQueryValue;
  readonly admission?: PreviewQueryValue;
  readonly screenShare?: PreviewQueryValue;
  readonly whiteboard?: PreviewQueryValue;
  readonly reactions?: PreviewQueryValue;
  readonly handRaise?: PreviewQueryValue;
  readonly info?: PreviewQueryValue;
  readonly settings?: PreviewQueryValue;
  readonly sounds?: PreviewQueryValue;
}

/** Explicit query-shaped values accepted by the route and toolbar patches. */
export interface PreviewSearchInput {
  readonly view?: PreviewQueryValue;
  readonly state?: PreviewQueryValue;
  readonly layout?: PreviewQueryValue;
  readonly panel?: PreviewQueryValue;
  readonly stage?: PreviewQueryValue;
  readonly stageBackground?: PreviewQueryValue;
  readonly dialog?: PreviewQueryValue;
  readonly skin?: PreviewQueryValue;
  readonly palette?: PreviewQueryValue;
  readonly texture?: PreviewQueryValue;
  readonly chrome?: PreviewQueryValue;
  readonly participants?: PreviewQueryValue;
  readonly chat?: PreviewQueryValue;
  readonly mic?: PreviewQueryValue;
  readonly camera?: PreviewQueryValue;
  readonly hand?: PreviewQueryValue;
  readonly activeSpeaker?: PreviewQueryValue;
  readonly screenShare?: PreviewQueryValue;
  readonly incomingMediaRequest?: PreviewQueryValue;
  readonly admissionQueue?: PreviewQueryValue;
  readonly diagnostics?: PreviewQueryValue;
  readonly role?: PreviewQueryValue;
  readonly capability?: PreviewQueryValue;
  readonly toast?: PreviewQueryValue;
  readonly microphone?: PreviewQueryValue;
  readonly ["active-speaker"]?: PreviewQueryValue;
  readonly ["screen-share"]?: PreviewQueryValue;
  readonly ["incoming-media-request"]?: PreviewQueryValue;
  readonly incomingRequest?: PreviewQueryValue;
  readonly ["admission-queue"]?: PreviewQueryValue;
  readonly rolePreset?: PreviewQueryValue;
  readonly capabilityPreset?: PreviewQueryValue;
  readonly capabilities?: PreviewQueryValue;
  readonly features?: PreviewFeatureInput | string;
  readonly ["feature-chat"]?: PreviewQueryValue;
  readonly ["feature-participants"]?: PreviewQueryValue;
  readonly ["feature-admission"]?: PreviewQueryValue;
  readonly ["feature-screenShare"]?: PreviewQueryValue;
  readonly ["feature-whiteboard"]?: PreviewQueryValue;
  readonly ["feature-reactions"]?: PreviewQueryValue;
  readonly ["feature-handRaise"]?: PreviewQueryValue;
  readonly ["feature-info"]?: PreviewQueryValue;
  readonly ["feature-settings"]?: PreviewQueryValue;
  readonly ["feature-sounds"]?: PreviewQueryValue;
  readonly ["features.chat"]?: PreviewQueryValue;
  readonly ["features.participants"]?: PreviewQueryValue;
  readonly ["features.admission"]?: PreviewQueryValue;
  readonly ["features.screenShare"]?: PreviewQueryValue;
  readonly ["features.whiteboard"]?: PreviewQueryValue;
  readonly ["features.reactions"]?: PreviewQueryValue;
  readonly ["features.handRaise"]?: PreviewQueryValue;
  readonly ["features.info"]?: PreviewQueryValue;
  readonly ["features.settings"]?: PreviewQueryValue;
  readonly ["features.sounds"]?: PreviewQueryValue;
}

export type PreviewSearchPatch = PreviewSearchInput;

export const DEFAULT_PREVIEW_SEARCH: PreviewSearch = {
  view: "entrance",
  state: "ready",
  layout: "focus",
  panel: "none",
  stage: "people",
  stageBackground: true,
  dialog: "none",
  skin: "classic",
  palette: "light",
  texture: "none",
  chrome: "hidden",
  participants: 2,
  chat: "ready",
  mic: "enabled",
  camera: "enabled",
  hand: false,
  activeSpeaker: "none",
  screenShare: "none",
  incomingMediaRequest: "none",
  admissionQueue: "empty",
  diagnostics: false,
  role: "collaborator",
  capability: "full",
  features: DEFAULT_PREVIEW_FEATURES,
  toast: "none",
};

export interface PreviewSerializeOptions {
  /** Keep values equal to their defaults when a complete query is useful. */
  readonly includeDefaults?: boolean;
}

type PreviewSearchSource = URLSearchParams | URL | string | PreviewSearchInput;
type PreviewSearchLike = PreviewSearchSource | PreviewSearchPatch;

const SEARCH_KEYS = [
  "view",
  "state",
  "layout",
  "panel",
  "stage",
  "stageBackground",
  "dialog",
  "skin",
  "palette",
  "texture",
  "chrome",
  "participants",
  "chat",
  "mic",
  "camera",
  "hand",
  "activeSpeaker",
  "screenShare",
  "incomingMediaRequest",
  "admissionQueue",
  "diagnostics",
  "role",
  "capability",
  "toast",
] as const;

const LEGACY_PALETTE_ALIASES: Readonly<Record<string, ThemePalette>> = {
  midnight: "oled-signal",
  slate: "cool-graphite",
  paper: "light",
  cosmic: "cosmic-chalk",
};

const LEGACY_TEXTURE_ALIASES: Readonly<Record<string, ThemeTexture>> = {
  "soft-grid": "paper",
  "soft-dots": "slate",
};

const LEGACY_SPACE_STATE_ALIASES: Readonly<Record<string, SpaceState>> = {
  failed: "failure",
  "post-live-failed": "failure",
};

const LEGACY_CAPABILITY_ALIASES: Readonly<Record<string, PreviewCapabilityPreset>> = {
  all: "full",
  member: "collaborator",
  viewer: "observer",
  restricted: "none",
};

function sourceValue<Key extends keyof PreviewSearchInput>(source: PreviewSearchSource | PreviewSearchPatch, key: Key): PreviewSearchInput[Key] | string | undefined;
function sourceValue(source: PreviewSearchSource | PreviewSearchPatch, key: keyof PreviewSearchInput): PreviewQueryValue | PreviewFeatureInput | undefined {
  if (source instanceof URLSearchParams) return source.get(key) ?? undefined;
  if (source instanceof URL) return source.searchParams.get(key) ?? undefined;

  if (typeof source === "string") {
    const query = source.includes("?") ? source.slice(source.indexOf("?") + 1).split("#", 1)[0] : source.replace(/^\?/, "");
    return new URLSearchParams(query).get(key) ?? undefined;
  }

  const value = source[key];
  return Array.isArray(value) ? value[0] : value;
}

function enumValue<T extends readonly string[]>(value: unknown, values: T, fallback: T[number], aliases: Readonly<Record<string, T[number]>> = {}): T[number] {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  const alias = aliases[normalized];
  if (alias !== undefined) return alias;
  return values.find((candidate) => candidate === normalized) ?? fallback;
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

function mediaValue(value: unknown, fallback: PreviewMediaState): PreviewMediaState {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "boolean") return value ? "enabled" : "disabled";
  if (typeof value === "number") return value === 1 ? "enabled" : "disabled";
  if (typeof value === "string") {
    switch (value.trim().toLowerCase()) {
      case "true":
      case "yes":
      case "on":
      case "1":
      case "active":
        return "enabled";
      case "false":
      case "no":
      case "off":
      case "0":
      case "inactive":
        return "disabled";
      default:
        return enumValue(value, PREVIEW_MEDIA_STATES, "disabled");
    }
  }
  return "disabled";
}

function participantCount(value: unknown): PreviewParticipants {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return DEFAULT_PREVIEW_SEARCH.participants;
  const exact = PREVIEW_PARTICIPANT_COUNTS.find((candidate) => candidate === parsed);
  if (exact !== undefined) return exact;

  return PREVIEW_PARTICIPANT_COUNTS.reduce((nearest, candidate) => (Math.abs(candidate - parsed) < Math.abs(nearest - parsed) ? candidate : nearest), PREVIEW_PARTICIPANT_COUNTS[0]);
}

function stateValues(view: PreviewView): readonly [PreviewState, ...PreviewState[]] {
  return view === "entrance" ? ENTRANCE_STATES : SPACE_STATES;
}

function defaultState(view: PreviewView): EntranceState | SpaceState {
  return view === "entrance" ? "ready" : "happy";
}

function featureValue(source: PreviewSearchLike, key: PreviewFeatureKey): unknown {
  const direct = sourceValue(source, `feature-${key}`);
  if (direct !== undefined) return direct;

  const dotted = sourceValue(source, `features.${key}`);
  if (dotted !== undefined) return dotted;

  const nested = sourceValue(source, "features");
  if (nested !== undefined && typeof nested !== "string") return nested[key];

  return undefined;
}

function paletteValue(value: unknown): PreviewPalette {
  return enumValue(value, PREVIEW_PALETTES, DEFAULT_PREVIEW_SEARCH.palette, LEGACY_PALETTE_ALIASES);
}

function textureValue(value: unknown): PreviewTexture {
  return enumValue(value, PREVIEW_TEXTURES, DEFAULT_PREVIEW_SEARCH.texture, LEGACY_TEXTURE_ALIASES);
}

function capabilityValue(value: unknown): PreviewCapabilityPreset {
  return enumValue(value, PREVIEW_CAPABILITY_PRESETS, DEFAULT_PREVIEW_SEARCH.capability, LEGACY_CAPABILITY_ALIASES);
}

/** Normalize any route/search input into the complete typed contract. */
export function normalizePreviewSearch(source: PreviewSearchLike = {}): PreviewSearch {
  const view = enumValue(sourceValue(source, "view"), PREVIEW_VIEWS, DEFAULT_PREVIEW_SEARCH.view);
  const state = enumValue(sourceValue(source, "state"), stateValues(view), defaultState(view), LEGACY_SPACE_STATE_ALIASES);
  const features: PreviewFeatures = {
    chat: booleanValue(featureValue(source, "chat"), DEFAULT_PREVIEW_FEATURES.chat),
    participants: booleanValue(featureValue(source, "participants"), DEFAULT_PREVIEW_FEATURES.participants),
    admission: booleanValue(featureValue(source, "admission"), DEFAULT_PREVIEW_FEATURES.admission),
    screenShare: booleanValue(featureValue(source, "screenShare"), DEFAULT_PREVIEW_FEATURES.screenShare),
    whiteboard: booleanValue(featureValue(source, "whiteboard"), DEFAULT_PREVIEW_FEATURES.whiteboard),
    reactions: booleanValue(featureValue(source, "reactions"), DEFAULT_PREVIEW_FEATURES.reactions),
    handRaise: booleanValue(featureValue(source, "handRaise"), DEFAULT_PREVIEW_FEATURES.handRaise),
    info: booleanValue(featureValue(source, "info"), DEFAULT_PREVIEW_FEATURES.info),
    settings: booleanValue(featureValue(source, "settings"), DEFAULT_PREVIEW_FEATURES.settings),
    sounds: booleanValue(featureValue(source, "sounds"), DEFAULT_PREVIEW_FEATURES.sounds),
  };

  return {
    view,
    state,
    layout: enumValue(sourceValue(source, "layout"), PREVIEW_LAYOUTS, DEFAULT_PREVIEW_SEARCH.layout),
    panel: enumValue(sourceValue(source, "panel"), PREVIEW_PANELS, DEFAULT_PREVIEW_SEARCH.panel),
    stage: enumValue(sourceValue(source, "stage"), PREVIEW_STAGES, DEFAULT_PREVIEW_SEARCH.stage),
    stageBackground: booleanValue(sourceValue(source, "stageBackground"), DEFAULT_PREVIEW_SEARCH.stageBackground),
    dialog: enumValue(sourceValue(source, "dialog"), PREVIEW_DIALOGS, DEFAULT_PREVIEW_SEARCH.dialog),
    skin: enumValue(sourceValue(source, "skin"), PREVIEW_SKINS, DEFAULT_PREVIEW_SEARCH.skin),
    palette: paletteValue(sourceValue(source, "palette")),
    texture: textureValue(sourceValue(source, "texture")),
    chrome: enumValue(sourceValue(source, "chrome"), PREVIEW_CHROME, DEFAULT_PREVIEW_SEARCH.chrome),
    participants: participantCount(sourceValue(source, "participants")),
    chat: enumValue(sourceValue(source, "chat"), PREVIEW_CHAT_STATES, DEFAULT_PREVIEW_SEARCH.chat),
    mic: mediaValue(sourceValue(source, "mic") ?? sourceValue(source, "microphone"), DEFAULT_PREVIEW_SEARCH.mic),
    camera: mediaValue(sourceValue(source, "camera"), DEFAULT_PREVIEW_SEARCH.camera),
    hand: booleanValue(sourceValue(source, "hand"), DEFAULT_PREVIEW_SEARCH.hand),
    activeSpeaker: enumValue(sourceValue(source, "activeSpeaker") ?? sourceValue(source, "active-speaker"), PREVIEW_ACTIVE_SPEAKERS, DEFAULT_PREVIEW_SEARCH.activeSpeaker),
    screenShare: enumValue(sourceValue(source, "screenShare") ?? sourceValue(source, "screen-share"), PREVIEW_SCREEN_SHARES, DEFAULT_PREVIEW_SEARCH.screenShare),
    incomingMediaRequest: enumValue(sourceValue(source, "incomingMediaRequest") ?? sourceValue(source, "incoming-media-request") ?? sourceValue(source, "incomingRequest"), PREVIEW_INCOMING_MEDIA_REQUESTS, DEFAULT_PREVIEW_SEARCH.incomingMediaRequest, { start_camera: "start-camera" }),
    admissionQueue: enumValue(sourceValue(source, "admissionQueue") ?? sourceValue(source, "admission-queue"), PREVIEW_ADMISSION_QUEUES, DEFAULT_PREVIEW_SEARCH.admissionQueue),
    diagnostics: booleanValue(sourceValue(source, "diagnostics"), DEFAULT_PREVIEW_SEARCH.diagnostics),
    role: enumValue(sourceValue(source, "role") ?? sourceValue(source, "rolePreset"), PREVIEW_ROLE_PRESETS, DEFAULT_PREVIEW_SEARCH.role, { member: "collaborator" }),
    capability: capabilityValue(sourceValue(source, "capability") ?? sourceValue(source, "capabilityPreset") ?? sourceValue(source, "capabilities")),
    features,
    toast: enumValue(sourceValue(source, "toast"), PREVIEW_TOASTS, DEFAULT_PREVIEW_SEARCH.toast),
  };
}

export const parsePreviewSearch = normalizePreviewSearch;

function differsFromDefault(key: keyof PreviewSearch, value: PreviewSearch[keyof PreviewSearch], search: PreviewSearch): boolean {
  if (key === "state") return value !== defaultState(search.view);
  if (key === "features") return PREVIEW_FEATURE_KEYS.some((feature) => search.features[feature] !== DEFAULT_PREVIEW_FEATURES[feature]);
  return value !== DEFAULT_PREVIEW_SEARCH[key];
}

/** Serialize a normalized search in a stable key order with minimal defaults. */
export function serializePreviewSearch(source: PreviewSearchLike = {}, options: PreviewSerializeOptions = {}): string {
  const search = normalizePreviewSearch(source);
  const params = new URLSearchParams();
  const includeDefaults = options.includeDefaults === true;

  for (const key of SEARCH_KEYS.slice(0, -1)) {
    const value = search[key];
    if (!includeDefaults && !differsFromDefault(key, value, search)) continue;
    params.set(key, String(value));
  }

  for (const feature of PREVIEW_FEATURE_KEYS) {
    const value = search.features[feature];
    if (includeDefaults || value !== DEFAULT_PREVIEW_FEATURES[feature]) params.set(`feature-${feature}`, String(value));
  }

  const toast = search.toast;
  if (includeDefaults || differsFromDefault("toast", toast, search)) params.set("toast", String(toast));

  return params.toString();
}

/** Update only the supplied typed values, preserving all current search state. */
export function patchPreviewSearch(current: PreviewSearchLike, updates: PreviewSearchPatch): PreviewSearch {
  const normalizedCurrent = normalizePreviewSearch(current);
  const updateFeatures = updates.features;
  const featurePatch: PreviewFeatureInput = typeof updateFeatures === "string" || updateFeatures === undefined ? {} : updateFeatures;

  return normalizePreviewSearch({
    ...normalizedCurrent,
    ...updates,
    features: { ...normalizedCurrent.features, ...featurePatch },
  });
}

/** Return a deterministic `/sdk-preview` URL for a complete or partial search. */
export function createPreviewHref(search: PreviewSearchLike = {}, base = "/sdk-preview"): string {
  const hashIndex = base.indexOf("#");
  const hash = hashIndex >= 0 ? base.slice(hashIndex) : "";
  const path = (hashIndex >= 0 ? base.slice(0, hashIndex) : base).split("?", 1)[0] ?? "/sdk-preview";
  const query = serializePreviewSearch(search);
  return `${path || "/sdk-preview"}${query ? `?${query}` : ""}${hash}`;
}
