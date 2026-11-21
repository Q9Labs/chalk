import { hrefOfSlug } from "./slug.ts";

type DocsGroup = {
  readonly id: string;
  readonly label: string;
};

type DocsPageSource = {
  readonly slug: string;
  readonly title: string;
  readonly navLabel: string;
  readonly description: string;
  readonly groupId: string;
  readonly keywords: readonly string[];
};

export const DOCS_GROUPS = [
  { id: "start", label: "Start" },
  { id: "concepts", label: "Core concepts" },
  { id: "sdks", label: "SDKs" },
  { id: "features", label: "Features" },
  { id: "platform", label: "Platform" },
  { id: "operations", label: "Operations" },
] as const satisfies readonly DocsGroup[];

const SOURCES = [
  {
    slug: "",
    title: "Why Chalk",
    navLabel: "Why Chalk",
    description: "Video calls inside your product, with chat and a whiteboard that last past the call.",
    groupId: "start",
    keywords: ["collaboration", "communication", "Space", "Episode", "durable"],
  },
  {
    slug: "quickstart",
    title: "Quickstart",
    navLabel: "Quickstart",
    description: "Install the TypeScript client, pass an AccessGrant, and join a Space.",
    groupId: "start",
    keywords: ["install", "join", "getAccess", "AccessGrant", "TypeScript"],
  },
  {
    slug: "spaces-and-episodes",
    title: "Spaces and Episodes",
    navLabel: "Spaces and Episodes",
    description: "Understand the durable Space and its bounded live Episode.",
    groupId: "concepts",
    keywords: ["Space", "Episode", "lifecycle", "deadline", "artifacts"],
  },
  {
    slug: "participants-and-presence",
    title: "Participants and Presence",
    navLabel: "Participants and Presence",
    description: "Model live seats, Presence, rosters, and admission requests.",
    groupId: "concepts",
    keywords: ["Participant", "Presence", "roster", "admission", "speaking"],
  },
  {
    slug: "users-agents-guests",
    title: "Users, Agents, and Guests",
    navLabel: "Users, Agents, Guests",
    description: "Choose the right identity boundary for durable and temporary access.",
    groupId: "concepts",
    keywords: ["User", "Agent", "Guest", "Member", "external_id"],
  },
  {
    slug: "roles-and-capabilities",
    title: "Roles and Capabilities",
    navLabel: "Roles and Capabilities",
    description: "Use capabilities for checks and Roles for customer-defined bundles.",
    groupId: "concepts",
    keywords: ["Role", "Capability", "owner", "collaborator", "observer", "permissions"],
  },
  {
    slug: "access-grants",
    title: "AccessGrants",
    navLabel: "AccessGrants",
    description: "Keep the signed client access envelope opaque and short-lived.",
    groupId: "concepts",
    keywords: ["AccessGrant", "access", "refresh", "retry", "credentials"],
  },
  {
    slug: "typescript",
    title: "TypeScript",
    navLabel: "TypeScript",
    description: "Use the framework-agnostic SpaceClient and SpaceSnapshot store.",
    groupId: "sdks",
    keywords: ["TypeScript", "SpaceClient", "SpaceSnapshot", "subscribe", "controllers"],
  },
  {
    slug: "react",
    title: "React",
    navLabel: "React",
    description: "Embed the turnkey Chalk surface or bind React to your own UI.",
    groupId: "sdks",
    keywords: ["React", "Chalk", "ChalkProvider", "hooks", "Entrance"],
  },
  {
    slug: "react-native",
    title: "React Native",
    navLabel: "React Native",
    description: "Use the matching React Native components, hooks, and native adapter.",
    groupId: "sdks",
    keywords: ["React Native", "android", "ios", "macos", "createNativeSpaceClient"],
  },
  {
    slug: "turnkey-ui",
    title: "Turnkey UI",
    navLabel: "Turnkey UI",
    description: "Configure feature flags, layouts, and themes for the complete surface.",
    groupId: "sdks",
    keywords: ["Chalk", "features", "theme", "skin", "layout", "classic"],
  },
  {
    slug: "custom-ui",
    title: "Custom UI",
    navLabel: "Custom UI",
    description: "Build your own panels with ChalkProvider and the closed hook set.",
    groupId: "sdks",
    keywords: ["custom", "ChalkProvider", "useCan", "useParticipants", "snapshot"],
  },
  {
    slug: "media",
    title: "Media",
    navLabel: "Media",
    description: "Control microphone, camera, devices, tracks, and media requests.",
    groupId: "features",
    keywords: ["media", "microphone", "camera", "devices", "requests"],
  },
  {
    slug: "screen-sharing",
    title: "Screen sharing",
    navLabel: "Screen sharing",
    description: "Publish and observe screen tracks through the media controller.",
    groupId: "features",
    keywords: ["screen", "screenShare", "publishScreen", "tracks", "presentation"],
  },
  {
    slug: "chat",
    title: "Chat",
    navLabel: "Chat",
    description: "Send durable Space messages, paginate history, upload files, and send reactions.",
    groupId: "features",
    keywords: ["chat", "messages", "attachments", "pagination", "read receipts", "reactions", "emoji", "sendReaction"],
  },
  {
    slug: "whiteboard",
    title: "Whiteboard",
    navLabel: "Whiteboard",
    description: "Add the Excalidraw-backed collaborative whiteboard.",
    groupId: "features",
    keywords: ["whiteboard", "Excalidraw", "WhiteboardCanvas", "scene", "math"],
  },
  {
    slug: "entrance-and-admission",
    title: "Entrance and admission",
    navLabel: "Entrance and admission",
    description: "Join a Space and control open, knock, or member entry.",
    groupId: "features",
    keywords: ["Entrance", "admission", "knock", "devices"],
  },
  {
    slug: "authentication",
    title: "Authentication",
    navLabel: "Authentication",
    description: "Keep identity, server credentials, and Participant access at clear boundaries.",
    groupId: "platform",
    keywords: ["authentication", "bearer", "API key", "identity", "AccessGrant"],
  },
  {
    slug: "webhooks",
    title: "Webhooks",
    navLabel: "Webhooks",
    description: "Verify raw bytes, deduplicate Event ids, and respond safely.",
    groupId: "platform",
    keywords: ["webhooks", "signature", "raw body", "idempotency", "inbox"],
  },
  {
    slug: "webhook-events",
    title: "Webhook events",
    navLabel: "Webhook events",
    description: "Choose typed Event subscriptions and inspect delivery outcomes.",
    groupId: "platform",
    keywords: ["Events", "event_types", "deliveries", "recording", "transcript"],
  },
  {
    slug: "public-api",
    title: "Public API",
    navLabel: "Public API",
    description: "Navigate the versioned OpenAPI contract for durable platform resources.",
    groupId: "platform",
    keywords: ["API", "OpenAPI", "HTTP", "v1", "pagination", "idempotency"],
  },
  {
    slug: "api-errors",
    title: "API errors",
    navLabel: "API errors",
    description: "Handle the stable error envelope, HTTP status, and retry headers.",
    groupId: "platform",
    keywords: ["errors", "ErrorResponse", "status", "Retry-After", "rate limit"],
  },
  {
    slug: "recovery",
    title: "Recovery",
    navLabel: "Recovery",
    description: "Let Connection refresh access and recover transports through one store.",
    groupId: "operations",
    keywords: ["recovery", "reconnect", "Connection", "refresh", "retry"],
  },
  {
    slug: "performance",
    title: "Performance",
    navLabel: "Performance",
    description: "Use stable snapshots and protocol bounds to keep the live path responsive.",
    groupId: "operations",
    keywords: ["performance", "stable slices", "bounds", "pagination", "disposal"],
  },
  {
    slug: "troubleshooting",
    title: "Troubleshooting",
    navLabel: "Troubleshooting",
    description: "Map stable client failures to the smallest safe recovery action.",
    groupId: "operations",
    keywords: ["troubleshooting", "errors", "recoverable", "media", "Sync", "whiteboard"],
  },
] as const satisfies readonly DocsPageSource[];

export type DocsPage = DocsPageSource & { readonly href: string };

export const DOCS_PAGES: readonly DocsPage[] = SOURCES.map((page) => ({ ...page, href: hrefOfSlug(page.slug) }));

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
