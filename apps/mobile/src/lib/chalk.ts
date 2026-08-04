import mobilePackageJson from "../../package.json";
import * as SecureStore from "expo-secure-store";
import { maskSecret } from "@q9labsai/chalk-react-native/diagnostics";
import { extractJoinTokenFromInviteLink } from "@q9labsai/chalk-react-native/invites";
import { getDeviceInfo, getReactNativeScriptUrl, resolveAppRuntimeUrl } from "@q9labsai/chalk-react-native/runtime";
import type { ClientSession as SpaceClient, ClientSessionCredential as AccessGrantCredential } from "@q9labsai/chalk-react-native";

import { parsePreviewRoute, type PreviewRoutePolicy, type SdkPreviewRoute } from "../dev-preview/preview-route";

const CLIENT_ACCESS_PREFIX = "chalk_mobile_client_session_v2.";
const LAST_INVITE_KEY = "chalk_mobile_last_invite_v2";
const PRODUCTION_BROKER_URL = "https://chalkmeet.com/local-chalk";
const ROUTE_FIELD = { spaceId: "roomId", spaceName: "roomName" } as const;

export interface MobileDebugContext {
  inviteTokenPreview: string | null;
  device: ReturnType<typeof getDeviceInfo>;
}

type BaseMeetingRoute = {
  [ROUTE_FIELD.spaceId]: string;
  role: "host" | "participant";
  joinToken?: string;
  [ROUTE_FIELD.spaceName]?: string;
  source: "new-space" | "join-link";
};

export type LobbyRoute = BaseMeetingRoute & {
  kind: "lobby";
};

export type MobileRoute = { kind: "home" } | LobbyRoute | SdkPreviewRoute;

export type MobileRoutePolicy = PreviewRoutePolicy;

export function getBrokerUrl(): string {
  return resolveAppRuntimeUrl({
    configuredUrl: process.env.EXPO_PUBLIC_CHALK_BROKER_URL?.trim(),
    scriptUrl: getReactNativeScriptUrl(),
    fallbackUrl: PRODUCTION_BROKER_URL,
    allowDeviceLocal: __DEV__,
  });
}

export function canCreateMeeting(): boolean {
  return true;
}

export async function createMeetingLobbyRoute(spaceName?: string): Promise<LobbyRoute> {
  return {
    kind: "lobby",
    [ROUTE_FIELD.spaceId]: "new-space",
    [ROUTE_FIELD.spaceName]: spaceName?.trim() || undefined,
    role: "host",
    source: "new-space",
  };
}

export async function resolveJoinToken(joinToken: string): Promise<LobbyRoute> {
  return {
    kind: "lobby",
    [ROUTE_FIELD.spaceId]: joinToken,
    role: "participant",
    joinToken,
    source: "join-link",
  };
}

export function parseInputDestination(input: string): LobbyRoute | null {
  return parseUrlLike(input);
}

/**
 * Resolve app-level links before invite parsing. Preview links are accepted
 * only when the caller explicitly supplies a development runtime policy.
 */
export function parseMobileRoute(url: string, policy: MobileRoutePolicy = { isDevRuntime: false }): MobileRoute | null {
  const previewRoute = parsePreviewRoute(url, policy);
  if (previewRoute) return previewRoute;

  return parseUrlLike(url);
}

export function parseUrlLike(url: string): LobbyRoute | null {
  const joinToken = extractJoinTokenFromInviteLink(url);
  return joinToken
    ? {
        kind: "lobby",
        [ROUTE_FIELD.spaceId]: joinToken,
        role: "participant",
        joinToken,
        source: "join-link",
      }
    : null;
}

export async function loadClientSessionCredential(inviteToken: string): Promise<AccessGrantCredential | undefined> {
  const value = await SecureStore.getItemAsync(credentialKey(inviteToken));
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as Partial<AccessGrantCredential>;
    if (parsed.inviteToken === inviteToken && isCapability(parsed.clientSessionId)) {
      return { clientSessionId: parsed.clientSessionId, inviteToken };
    }
  } catch {
    // Invalid local state is removed below.
  }
  await SecureStore.deleteItemAsync(credentialKey(inviteToken));
  return undefined;
}

export async function saveClientSessionCredential(credential: AccessGrantCredential): Promise<void> {
  await Promise.all([SecureStore.setItemAsync(credentialKey(credential.inviteToken), JSON.stringify(credential)), SecureStore.setItemAsync(LAST_INVITE_KEY, credential.inviteToken)]);
}

export async function clearClientSessionCredential(inviteToken: string): Promise<void> {
  const lastInviteToken = await SecureStore.getItemAsync(LAST_INVITE_KEY);
  await Promise.all([SecureStore.deleteItemAsync(credentialKey(inviteToken)), ...(lastInviteToken === inviteToken ? [SecureStore.deleteItemAsync(LAST_INVITE_KEY)] : [])]);
}

export async function cleanupClientSession(spaceClient: SpaceClient): Promise<void> {
  try {
    await spaceClient.cleanup();
  } finally {
    await clearClientSessionCredential(spaceClient.inviteToken);
  }
}

export async function clearJoinContext(): Promise<void> {
  const inviteToken = await SecureStore.getItemAsync(LAST_INVITE_KEY);
  await Promise.all([...(inviteToken ? [SecureStore.deleteItemAsync(credentialKey(inviteToken))] : []), SecureStore.deleteItemAsync(LAST_INVITE_KEY)]);
}

export async function getMobileDebugContext(): Promise<MobileDebugContext> {
  const inviteToken = await SecureStore.getItemAsync(LAST_INVITE_KEY);
  return {
    inviteTokenPreview: maskSecret(inviteToken),
    device: getDeviceInfo({
      appVersion: typeof (mobilePackageJson as { version?: string }).version === "string" ? (mobilePackageJson as { version?: string }).version : null,
    }),
  };
}

function credentialKey(inviteToken: string): string {
  return `${CLIENT_ACCESS_PREFIX}${inviteToken}`;
}

function isCapability(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/u.test(value);
}
