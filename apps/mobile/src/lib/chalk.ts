import { APIClient, createTokenProvider, humanizeRoomName } from "@q9labs/chalk-core";
import * as SecureStore from "expo-secure-store";
import { NativeModules } from "react-native";
import { createStorageScopeId, isConfiguredLocalApiUrl, resolveAppRuntimeUrl } from "./mobile-runtime";
import { createHostTokenStorage } from "./host-token-storage";
import { extractJoinTokenFromInviteLink } from "./inviteLink";
import { createHostedMeeting } from "./newMeeting";

const JOIN_CONTEXT_KEY = "chalk_mobile_join_context_v1";
const LOCAL_DEV_HOST_API_KEY_KEY = "chalk_mobile_local_dev_host_api_key_v1";
const PROD_API_URL = "https://chalk-api.q9labs.ai";
const PROD_WS_URL = "wss://chalk-ws.q9labs.ai/ws";

export type JoinContext = {
  joinToken: string;
  roomName?: string;
  accessToken?: string;
  expiresAtMs?: number;
};

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

let cachedHostTokenProvider: (() => Promise<string>) | null = null;
let cachedHostTokenProviderKey: string | null = null;
let cachedLocalDevHostApiKey: string | null | undefined;

export function getApiUrl(): string {
  const configured = process.env.EXPO_PUBLIC_API_URL?.trim();
  return resolveAppRuntimeUrl({
    configuredUrl: configured,
    scriptUrl: NativeModules.SourceCode?.scriptURL ?? NativeModules.SourceCode?.getConstants?.().scriptURL,
    fallbackUrl: PROD_API_URL,
    allowDeviceLocal: __DEV__,
  });
}

export function getWsUrl(apiUrl = getApiUrl()): string | undefined {
  const configured = process.env.EXPO_PUBLIC_WS_URL?.trim();
  if (configured) {
    return resolveAppRuntimeUrl({
      configuredUrl: configured,
      scriptUrl: NativeModules.SourceCode?.scriptURL ?? NativeModules.SourceCode?.getConstants?.().scriptURL,
      fallbackUrl: PROD_WS_URL,
      allowDeviceLocal: __DEV__,
    });
  }

  try {
    const api = new URL(apiUrl);
    if (api.host === "chalk-api.q9labs.ai") {
      return PROD_WS_URL;
    }

    const wsProtocol = api.protocol === "https:" ? "wss:" : "ws:";
    return `${wsProtocol}//${api.host}/ws`;
  } catch {
    return undefined;
  }
}

export function getHostApiKey(): string | null {
  const configured = process.env.EXPO_PUBLIC_CHALK_API_KEY?.trim();
  return configured || null;
}

export function canCreateMeeting(): boolean {
  return getHostApiKey() !== null || canBootstrapLocalHostKey();
}

export function canBootstrapLocalHostKey(configuredApiUrl = process.env.EXPO_PUBLIC_API_URL?.trim()): boolean {
  return isConfiguredLocalApiUrl(configuredApiUrl);
}

function getTokenProviderForKey(apiUrl: string, apiKey: string): () => Promise<string> {
  const cacheKey = `${apiUrl}:${createStorageScopeId(apiUrl, apiKey)}`;
  if (cachedHostTokenProvider && cachedHostTokenProviderKey === cacheKey) {
    return cachedHostTokenProvider;
  }

  cachedHostTokenProvider = createTokenProvider({
    apiKey,
    apiUrl,
    storage: createHostTokenStorage(apiUrl, apiKey),
  });
  cachedHostTokenProviderKey = cacheKey;
  return cachedHostTokenProvider;
}

async function getLocalDevHostApiKey(): Promise<string | null> {
  if (cachedLocalDevHostApiKey !== undefined) {
    return cachedLocalDevHostApiKey;
  }

  cachedLocalDevHostApiKey = await SecureStore.getItemAsync(LOCAL_DEV_HOST_API_KEY_KEY);
  return cachedLocalDevHostApiKey;
}

async function setLocalDevHostApiKey(apiKey: string): Promise<void> {
  cachedLocalDevHostApiKey = apiKey;
  await SecureStore.setItemAsync(LOCAL_DEV_HOST_API_KEY_KEY, apiKey);
}

async function createLocalDevHostApiKey(apiUrl: string): Promise<string> {
  const response = await fetch(`${apiUrl}/api/v1/tenants`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      name: `Chalk Mobile Local ${new Date().toISOString()}`,
      max_concurrent_rooms: 100,
      max_participants_per_room: 20,
      max_recording_duration_minutes: 120,
    }),
  });

  const data = (await response.json().catch(() => null)) as { api_key?: string; error?: string } | null;

  if (!response.ok || !data?.api_key) {
    throw new Error(data?.error ?? "Local host bootstrap failed");
  }

  await setLocalDevHostApiKey(data.api_key);
  return data.api_key;
}

export function getHostTokenProvider(apiUrl: string): (() => Promise<string>) | null {
  const configuredApiKey = getHostApiKey();
  if (!configuredApiKey && !canBootstrapLocalHostKey()) {
    return null;
  }

  return async () => {
    let apiKey = configuredApiKey ?? (canBootstrapLocalHostKey() ? await getLocalDevHostApiKey() : null);

    if (!apiKey) {
      apiKey = await createLocalDevHostApiKey(apiUrl);
    }

    try {
      return await getTokenProviderForKey(apiUrl, apiKey)();
    } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : "";
      if (!canBootstrapLocalHostKey() || !message.includes("invalid api key")) {
        throw error;
      }

      apiKey = await createLocalDevHostApiKey(apiUrl);
      return getTokenProviderForKey(apiUrl, apiKey)();
    }
  };
}

export async function getJoinContext(): Promise<JoinContext | null> {
  const raw = await SecureStore.getItemAsync(JOIN_CONTEXT_KEY);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as JoinContext;
    if (parsed.expiresAtMs && Date.now() >= parsed.expiresAtMs) {
      await clearJoinContext();
      return null;
    }
    return parsed;
  } catch {
    await clearJoinContext();
    return null;
  }
}

export async function setJoinContext(context: JoinContext): Promise<void> {
  await SecureStore.setItemAsync(JOIN_CONTEXT_KEY, JSON.stringify(context));
}

export async function clearJoinContext(): Promise<void> {
  await SecureStore.deleteItemAsync(JOIN_CONTEXT_KEY);
}

export async function resolveJoinToken(joinToken: string, apiUrl: string): Promise<LobbyRoute> {
  const client = new APIClient({ apiUrl });
  const response = await client.exchangeJoinToken(joinToken);
  if (!response.success || !response.data) {
    throw new Error(response.error?.message ?? "Invalid join link");
  }

  const roomId = response.data.roomId || response.data.roomName;
  const roomName = humanizeRoomName(response.data.roomName || roomId);

  const context: JoinContext = {
    joinToken,
    roomName,
    accessToken: response.data.accessToken,
    expiresAtMs: Date.now() + response.data.expiresIn * 1000,
  };
  await setJoinContext(context);

  return {
    kind: "lobby",
    roomId,
    role: "participant",
    joinToken,
    roomName,
    source: "join-link",
  };
}

export async function getJoinAccessToken(apiUrl: string, joinToken: string): Promise<string> {
  const context = await getJoinContext();
  if (context?.joinToken === joinToken && context.accessToken && context.expiresAtMs && Date.now() < context.expiresAtMs - 5_000) {
    return context.accessToken;
  }

  await resolveJoinToken(joinToken, apiUrl);
  const nextContext = await getJoinContext();
  if (!nextContext?.accessToken) {
    throw new Error("Join token exchange did not return an access token");
  }

  return nextContext.accessToken;
}

export async function createMeetingLobbyRoute(apiUrl: string): Promise<LobbyRoute> {
  const getAccessToken = getHostTokenProvider(apiUrl);
  if (!getAccessToken) {
    throw new Error("Meeting creation is currently restricted.");
  }

  const createdRoom = await createHostedMeeting(apiUrl, getAccessToken);
  return {
    kind: "lobby",
    roomId: createdRoom.roomId,
    roomName: createdRoom.roomName,
    role: "host",
    source: "new-meeting",
  };
}

export function parseInputDestination(input: string): LobbyRoute | null {
  return parseUrlLike(input);
}

export function parseUrlLike(url: string): LobbyRoute | null {
  const joinToken = extractJoinTokenFromInviteLink(url);
  if (!joinToken) {
    return null;
  }

  return {
    kind: "lobby",
    roomId: joinToken,
    role: "participant",
    joinToken,
    source: "join-link",
  };
}
