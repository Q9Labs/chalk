import { lazy, type LazyExoticComponent } from "react";
import type { MDXContent } from "mdx/types";

const WhyChalk = lazy(() => import("./content/why-chalk.mdx"));
const Quickstart = lazy(() => import("./content/quickstart.mdx"));
const SpacesAndEpisodes = lazy(() => import("./content/spaces-and-episodes.mdx"));
const ParticipantsAndPresence = lazy(() => import("./content/participants-and-presence.mdx"));
const UsersAgentsGuests = lazy(() => import("./content/users-agents-guests.mdx"));
const RolesAndCapabilities = lazy(() => import("./content/roles-and-capabilities.mdx"));
const AccessGrants = lazy(() => import("./content/access-grants.mdx"));
const TypeScript = lazy(() => import("./content/typescript.mdx"));
const React = lazy(() => import("./content/react.mdx"));
const ReactNative = lazy(() => import("./content/react-native.mdx"));
const TurnkeyUI = lazy(() => import("./content/turnkey-ui.mdx"));
const CustomUI = lazy(() => import("./content/custom-ui.mdx"));
const Media = lazy(() => import("./content/media.mdx"));
const ScreenSharing = lazy(() => import("./content/screen-sharing.mdx"));
const Chat = lazy(() => import("./content/chat.mdx"));
const Whiteboard = lazy(() => import("./content/whiteboard.mdx"));
const EntranceAndAdmission = lazy(() => import("./content/entrance-and-admission.mdx"));
const Authentication = lazy(() => import("./content/authentication.mdx"));
const Webhooks = lazy(() => import("./content/webhooks.mdx"));
const WebhookEvents = lazy(() => import("./content/webhook-events.mdx"));
const PublicAPI = lazy(() => import("./content/public-api.mdx"));
const ApiErrors = lazy(() => import("./content/api-errors.mdx"));
const Recovery = lazy(() => import("./content/recovery.mdx"));
const Performance = lazy(() => import("./content/performance.mdx"));
const Troubleshooting = lazy(() => import("./content/troubleshooting.mdx"));

type DocsContent = LazyExoticComponent<MDXContent>;

type DocsGroup = {
  readonly id: string;
  readonly label: string;
};

export type DocsPage = {
  readonly slug: string;
  readonly href: string;
  readonly title: string;
  readonly navLabel: string;
  readonly description: string;
  readonly groupId: string;
  readonly keywords: readonly string[];
  readonly Content: DocsContent;
};

export const DOCS_GROUPS = [
  { id: "start", label: "Start" },
  { id: "concepts", label: "Core concepts" },
  { id: "sdks", label: "SDKs" },
  { id: "features", label: "Features" },
  { id: "platform", label: "Platform" },
  { id: "operations", label: "Operations" },
] as const satisfies readonly DocsGroup[];

export const DOCS_PAGES = [
  {
    slug: "",
    href: "/docs",
    title: "Why Chalk",
    navLabel: "Why Chalk",
    description: "A durable Space and bounded Episodes for live collaboration.",
    groupId: "start",
    keywords: ["collaboration", "communication", "Space", "Episode", "durable"],
    Content: WhyChalk,
  },
  {
    slug: "quickstart",
    href: "/docs/quickstart",
    title: "Quickstart",
    navLabel: "Quickstart",
    description: "Install the TypeScript client, pass an AccessGrant, and join a Space.",
    groupId: "start",
    keywords: ["install", "join", "getAccess", "AccessGrant", "TypeScript"],
    Content: Quickstart,
  },
  {
    slug: "spaces-and-episodes",
    href: "/docs/spaces-and-episodes",
    title: "Spaces and Episodes",
    navLabel: "Spaces and Episodes",
    description: "Understand the durable Space and its bounded live Episode.",
    groupId: "concepts",
    keywords: ["Space", "Episode", "lifecycle", "deadline", "artifacts"],
    Content: SpacesAndEpisodes,
  },
  {
    slug: "participants-and-presence",
    href: "/docs/participants-and-presence",
    title: "Participants and Presence",
    navLabel: "Participants and Presence",
    description: "Model live seats, Presence, rosters, and admission requests.",
    groupId: "concepts",
    keywords: ["Participant", "Presence", "roster", "admission", "speaking"],
    Content: ParticipantsAndPresence,
  },
  {
    slug: "users-agents-guests",
    href: "/docs/users-agents-guests",
    title: "Users, Agents, and Guests",
    navLabel: "Users, Agents, Guests",
    description: "Choose the right identity boundary for durable and temporary access.",
    groupId: "concepts",
    keywords: ["User", "Agent", "Guest", "Member", "external_id"],
    Content: UsersAgentsGuests,
  },
  {
    slug: "roles-and-capabilities",
    href: "/docs/roles-and-capabilities",
    title: "Roles and Capabilities",
    navLabel: "Roles and Capabilities",
    description: "Use capabilities for checks and Roles for customer-defined bundles.",
    groupId: "concepts",
    keywords: ["Role", "Capability", "owner", "collaborator", "observer", "permissions"],
    Content: RolesAndCapabilities,
  },
  {
    slug: "access-grants",
    href: "/docs/access-grants",
    title: "AccessGrants",
    navLabel: "AccessGrants",
    description: "Keep the signed client access envelope opaque and short-lived.",
    groupId: "concepts",
    keywords: ["AccessGrant", "access", "refresh", "retry", "credentials"],
    Content: AccessGrants,
  },
  {
    slug: "typescript",
    href: "/docs/typescript",
    title: "TypeScript",
    navLabel: "TypeScript",
    description: "Use the framework-agnostic SpaceClient and SpaceSnapshot store.",
    groupId: "sdks",
    keywords: ["TypeScript", "SpaceClient", "SpaceSnapshot", "subscribe", "controllers"],
    Content: TypeScript,
  },
  {
    slug: "react",
    href: "/docs/react",
    title: "React",
    navLabel: "React",
    description: "Embed the turnkey Chalk surface or bind React to your own UI.",
    groupId: "sdks",
    keywords: ["React", "Chalk", "ChalkProvider", "hooks", "Entrance"],
    Content: React,
  },
  {
    slug: "react-native",
    href: "/docs/react-native",
    title: "React Native",
    navLabel: "React Native",
    description: "Use the matching React Native components, hooks, and native adapter.",
    groupId: "sdks",
    keywords: ["React Native", "android", "ios", "macos", "createNativeSpaceClient"],
    Content: ReactNative,
  },
  {
    slug: "turnkey-ui",
    href: "/docs/turnkey-ui",
    title: "Turnkey UI",
    navLabel: "Turnkey UI",
    description: "Configure feature flags, layouts, and themes for the complete surface.",
    groupId: "sdks",
    keywords: ["Chalk", "features", "theme", "skin", "layout", "classic"],
    Content: TurnkeyUI,
  },
  {
    slug: "custom-ui",
    href: "/docs/custom-ui",
    title: "Custom UI",
    navLabel: "Custom UI",
    description: "Build your own panels with ChalkProvider and the closed hook set.",
    groupId: "sdks",
    keywords: ["custom", "ChalkProvider", "useCan", "useParticipants", "snapshot"],
    Content: CustomUI,
  },
  {
    slug: "media",
    href: "/docs/media",
    title: "Media",
    navLabel: "Media",
    description: "Control microphone, camera, devices, tracks, and media requests.",
    groupId: "features",
    keywords: ["media", "microphone", "camera", "devices", "requests"],
    Content: Media,
  },
  {
    slug: "screen-sharing",
    href: "/docs/screen-sharing",
    title: "Screen sharing",
    navLabel: "Screen sharing",
    description: "Publish and observe screen tracks through the media controller.",
    groupId: "features",
    keywords: ["screen", "screenShare", "publishScreen", "tracks", "presentation"],
    Content: ScreenSharing,
  },
  {
    slug: "chat",
    href: "/docs/chat",
    title: "Chat",
    navLabel: "Chat",
    description: "Send durable Space messages, paginate history, upload files, and send reactions.",
    groupId: "features",
    keywords: ["chat", "messages", "attachments", "pagination", "read receipts", "reactions", "emoji", "sendReaction"],
    Content: Chat,
  },
  {
    slug: "whiteboard",
    href: "/docs/whiteboard",
    title: "Whiteboard",
    navLabel: "Whiteboard",
    description: "Add the Excalidraw-backed collaborative whiteboard.",
    groupId: "features",
    keywords: ["whiteboard", "Excalidraw", "WhiteboardCanvas", "scene", "math"],
    Content: Whiteboard,
  },
  {
    slug: "entrance-and-admission",
    href: "/docs/entrance-and-admission",
    title: "Entrance and admission",
    navLabel: "Entrance and admission",
    description: "Join a Space and control open, knock, or member entry.",
    groupId: "features",
    keywords: ["Entrance", "admission", "knock", "devices"],
    Content: EntranceAndAdmission,
  },
  {
    slug: "authentication",
    href: "/docs/authentication",
    title: "Authentication",
    navLabel: "Authentication",
    description: "Keep identity, server credentials, and Participant access at clear boundaries.",
    groupId: "platform",
    keywords: ["authentication", "bearer", "API key", "identity", "AccessGrant"],
    Content: Authentication,
  },
  {
    slug: "webhooks",
    href: "/docs/webhooks",
    title: "Webhooks",
    navLabel: "Webhooks",
    description: "Verify raw bytes, deduplicate Event ids, and respond safely.",
    groupId: "platform",
    keywords: ["webhooks", "signature", "raw body", "idempotency", "inbox"],
    Content: Webhooks,
  },
  {
    slug: "webhook-events",
    href: "/docs/webhook-events",
    title: "Webhook events",
    navLabel: "Webhook events",
    description: "Choose typed Event subscriptions and inspect delivery outcomes.",
    groupId: "platform",
    keywords: ["Events", "event_types", "deliveries", "recording", "transcript"],
    Content: WebhookEvents,
  },
  {
    slug: "public-api",
    href: "/docs/public-api",
    title: "Public API",
    navLabel: "Public API",
    description: "Navigate the versioned OpenAPI contract for durable platform resources.",
    groupId: "platform",
    keywords: ["API", "OpenAPI", "HTTP", "v1", "pagination", "idempotency"],
    Content: PublicAPI,
  },
  {
    slug: "api-errors",
    href: "/docs/api-errors",
    title: "API errors",
    navLabel: "API errors",
    description: "Handle the stable error envelope, HTTP status, and retry headers.",
    groupId: "platform",
    keywords: ["errors", "ErrorResponse", "status", "Retry-After", "rate limit"],
    Content: ApiErrors,
  },
  {
    slug: "recovery",
    href: "/docs/recovery",
    title: "Recovery",
    navLabel: "Recovery",
    description: "Let Connection refresh access and recover transports through one store.",
    groupId: "operations",
    keywords: ["recovery", "reconnect", "Connection", "refresh", "retry"],
    Content: Recovery,
  },
  {
    slug: "performance",
    href: "/docs/performance",
    title: "Performance",
    navLabel: "Performance",
    description: "Use stable snapshots and protocol bounds to keep the live path responsive.",
    groupId: "operations",
    keywords: ["performance", "stable slices", "bounds", "pagination", "disposal"],
    Content: Performance,
  },
  {
    slug: "troubleshooting",
    href: "/docs/troubleshooting",
    title: "Troubleshooting",
    navLabel: "Troubleshooting",
    description: "Map stable client failures to the smallest safe recovery action.",
    groupId: "operations",
    keywords: ["troubleshooting", "errors", "recoverable", "media", "Sync", "whiteboard"],
    Content: Troubleshooting,
  },
] as const satisfies readonly DocsPage[];

export function findDocsPage(slug: string): DocsPage | undefined {
  return DOCS_PAGES.find((page) => page.slug === slug);
}

export function getAdjacentDocsPages(slug: string): {
  previous: DocsPage | undefined;
  next: DocsPage | undefined;
} {
  const index = DOCS_PAGES.findIndex((page) => page.slug === slug);
  if (index < 0) return { previous: undefined, next: undefined };
  return {
    previous: DOCS_PAGES[index - 1],
    next: DOCS_PAGES[index + 1],
  };
}
