import mobilePackageJson from "../../package.json";
import * as SecureStore from "expo-secure-store";
import { maskSecret } from "@q9labsai/chalk-react-native/diagnostics";
import { extractJoinTokenFromInviteLink } from "@q9labsai/chalk-react-native/invites";
import { getNativeDeviceInfo, getReactNativeScriptUrl, resolveAppRuntimeUrl } from "@q9labsai/chalk-react-native/runtime";
import type { ChalkClientSessionCredential } from "@q9labsai/chalk-react-native";

const CLIENT_SESSION_PREFIX = "chalk_mobile_client_session_v2.";
const LAST_INVITE_KEY = "chalk_mobile_last_invite_v2";
const PRODUCTION_BROKER_URL = "https://chalkmeet.com/local-chalk";

export interface MobileDebugContext {
  inviteTokenPreview: string | null;
  device: ReturnType<typeof getNativeDeviceInfo>;
}

type BaseMeetingRoute = {
  roomId: string;
  role: "host" | "participant";
  joinToken?: string;
  roomName?: string;
  source: "new-meeting" | "join-link";
};

export type LobbyRoute = BaseMeetingRoute & {
  kind: "lobby";
};

export type MobileRoute = { kind: "home" } | LobbyRoute;

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

export async function createMeetingLobbyRoute(roomName?: string): Promise<LobbyRoute> {
  return {
    kind: "lobby",
    roomId: "new-meeting",
    roomName: roomName?.trim() || undefined,
    role: "host",
    source: "new-meeting",
  };
}

export async function resolveJoinToken(joinToken: string): Promise<LobbyRoute> {
  return {
    kind: "lobby",
    roomId: joinToken,
    role: "participant",
    joinToken,
    source: "join-link",
  };
}

export function parseInputDestination(input: string): LobbyRoute | null {
  return parseUrlLike(input);
}

export function parseUrlLike(url: string): LobbyRoute | null {
  const joinToken = extractJoinTokenFromInviteLink(url);
  return joinToken
    ? {
        kind: "lobby",
        roomId: joinToken,
        role: "participant",
        joinToken,
        source: "join-link",
      }
    : null;
}

export async function loadClientSessionCredential(inviteToken: string): Promise<ChalkClientSessionCredential | undefined> {
  const value = await SecureStore.getItemAsync(credentialKey(inviteToken));
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as Partial<ChalkClientSessionCredential>;
    if (parsed.inviteToken === inviteToken && isCapability(parsed.clientSessionId)) {
      return { clientSessionId: parsed.clientSessionId, inviteToken };
    }
  } catch {
    // Invalid local state is removed below.
  }
  await SecureStore.deleteItemAsync(credentialKey(inviteToken));
  return undefined;
}

export async function saveClientSessionCredential(credential: ChalkClientSessionCredential): Promise<void> {
  await Promise.all([SecureStore.setItemAsync(credentialKey(credential.inviteToken), JSON.stringify(credential)), SecureStore.setItemAsync(LAST_INVITE_KEY, credential.inviteToken)]);
}

export async function clearClientSessionCredential(inviteToken: string): Promise<void> {
  await SecureStore.deleteItemAsync(credentialKey(inviteToken));
}

export async function clearJoinContext(): Promise<void> {
  const inviteToken = await SecureStore.getItemAsync(LAST_INVITE_KEY);
  await Promise.all([...(inviteToken ? [SecureStore.deleteItemAsync(credentialKey(inviteToken))] : []), SecureStore.deleteItemAsync(LAST_INVITE_KEY)]);
}

export async function getMobileDebugContext(): Promise<MobileDebugContext> {
  const inviteToken = await SecureStore.getItemAsync(LAST_INVITE_KEY);
  return {
    inviteTokenPreview: maskSecret(inviteToken),
    device: getNativeDeviceInfo({
      appVersion: typeof (mobilePackageJson as { version?: string }).version === "string" ? (mobilePackageJson as { version?: string }).version : null,
    }),
  };
}

function credentialKey(inviteToken: string): string {
  return `${CLIENT_SESSION_PREFIX}${inviteToken}`;
}

function isCapability(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/u.test(value);
}
