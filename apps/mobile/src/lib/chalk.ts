import { APIClient, createFriendlyRoomName, createTokenProvider, humanizeRoomName } from "@q9labs/chalk-core";
import * as SecureStore from "expo-secure-store";
import { NativeModules } from "react-native";
import { createStorageScopeId, resolveDeviceLocalUrl } from "./mobile-runtime";
import { createHostTokenStorage, HOST_ACCESS_TOKEN_KEY, HOST_EXPIRES_KEY, HOST_REFRESH_TOKEN_KEY, LEGACY_HOST_TOKEN_PREFIXES } from "./host-token-storage";

const JOIN_CONTEXT_KEY = "chalk_mobile_join_context_v1";
const HOST_ROLE_REQUIRED_ERROR = "host role required";
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
  source: "new-meeting" | "join-link" | "direct-room";
};

export type LobbyRoute = BaseMeetingRoute & {
  kind: "lobby";
};

export type MobileRoute = { kind: "home" } | LobbyRoute;

let cachedHostTokenProvider: (() => Promise<string>) | null = null;
let cachedHostTokenProviderKey: string | null = null;

export function getApiUrl(): string {
  const configured = process.env.EXPO_PUBLIC_API_URL?.trim();
  return resolveDeviceLocalUrl(configured || PROD_API_URL, NativeModules.SourceCode?.scriptURL ?? NativeModules.SourceCode?.getConstants?.().scriptURL, PROD_API_URL);
}

export function getWsUrl(apiUrl = getApiUrl()): string | undefined {
  const configured = process.env.EXPO_PUBLIC_WS_URL?.trim();
  if (configured) {
    return resolveDeviceLocalUrl(configured, NativeModules.SourceCode?.scriptURL ?? NativeModules.SourceCode?.getConstants?.().scriptURL, PROD_WS_URL);
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
  return getHostApiKey() !== null;
}

export function getHostTokenProvider(apiUrl: string): (() => Promise<string>) | null {
  const apiKey = getHostApiKey();
  if (!apiKey) {
    return null;
  }

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

async function clearHostAuthState(apiUrl: string): Promise<void> {
  const apiKey = getHostApiKey();
  cachedHostTokenProvider = null;
  cachedHostTokenProviderKey = null;

  const removals = LEGACY_HOST_TOKEN_PREFIXES.flatMap((prefix) => [HOST_ACCESS_TOKEN_KEY, HOST_REFRESH_TOKEN_KEY, HOST_EXPIRES_KEY].map((key) => SecureStore.deleteItemAsync(`${prefix}${key}`)));

  if (apiKey) {
    const storage = createHostTokenStorage(apiUrl, apiKey);
    removals.push(Promise.resolve(storage.remove(HOST_ACCESS_TOKEN_KEY)), Promise.resolve(storage.remove(HOST_REFRESH_TOKEN_KEY)), Promise.resolve(storage.remove(HOST_EXPIRES_KEY)));
  }

  await Promise.all(removals);
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
  const friendlyRoom = createFriendlyRoomName();
  const roomName = friendlyRoom.label;
  const createRoom = async () => {
    const tokenProvider = getHostTokenProvider(apiUrl);
    if (!tokenProvider) {
      throw new Error("Meeting creation is currently restricted.");
    }

    const client = new APIClient({ apiUrl, tokenProvider });
    return client.createRoom({ name: roomName });
  };

  let response = await createRoom();
  if (!response.success && response.error?.message?.toLowerCase() === HOST_ROLE_REQUIRED_ERROR) {
    await clearHostAuthState(apiUrl);
    response = await createRoom();
  }

  if (!response.success || !response.data) {
    throw new Error(response.error?.message ?? "Unable to create meeting");
  }

  return {
    kind: "lobby",
    roomId: response.data.id,
    roomName: response.data.name?.trim() || roomName,
    role: "host",
    source: "new-meeting",
  };
}

export function parseInputDestination(input: string): LobbyRoute | null {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }

  const parsed = parseUrlLike(trimmed);
  if (parsed) {
    return parsed;
  }

  return {
    kind: "lobby",
    roomId: trimmed,
    roomName: humanizeRoomName(trimmed),
    role: "participant",
    source: "direct-room",
  };
}

export function parseUrlLike(url: string): LobbyRoute | null {
  try {
    const parsed = new URL(url);
    const pathSegments = parsed.protocol === "chalk:" ? [parsed.hostname, ...parsed.pathname.split("/").filter(Boolean)] : parsed.pathname.split("/").filter(Boolean);
    const [head, tail] = pathSegments;

    if (head === "j" && tail) {
      return {
        kind: "lobby",
        roomId: tail,
        role: "participant",
        joinToken: tail,
        source: "join-link",
      };
    }

    if (head === "room" && tail) {
      const roomId = decodeURIComponent(tail);
      return {
        kind: "lobby",
        roomId,
        roomName: humanizeRoomName(roomId),
        role: "participant",
        source: "direct-room",
      };
    }

    return null;
  } catch {
    return null;
  }
}
