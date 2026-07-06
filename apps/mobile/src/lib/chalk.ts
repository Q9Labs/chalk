import mobilePackageJson from "../../package.json";
import * as SecureStore from "expo-secure-store";
import { decodeTokenClaimsPreview, maskSecret, recordManualRequest, type DevDiagnosticsTokenClaimsPreview } from "@q9labs/chalk-react-native/diagnostics";
import { extractJoinTokenFromInviteLink } from "@q9labs/chalk-react-native/invites";
import { canUseLocalHostBootstrap, createStorageScopeId, getNativeDeviceInfo, getReactNativeScriptUrl, resolveAppRuntimeUrl } from "@q9labs/chalk-react-native/runtime";
import { createSecureStoreTokenStorage, HOST_ACCESS_TOKEN_KEY, HOST_EXPIRES_KEY, HOST_REFRESH_TOKEN_KEY, type NativeTokenStorage } from "@q9labs/chalk-react-native/storage";
import { createTokenProvider } from "./mobile-auth";
import { getCanonicalJoinRoomId, getJoinRoomName } from "./join-exchange";
import { createHostedMeeting } from "./newMeeting";

const JOIN_CONTEXT_KEY = "chalk_mobile_join_context_v1";
const LOCAL_DEV_HOST_API_KEY_KEY = "chalk_mobile_local_dev_host_api_key_v1";
const INTERNAL_CLIENT_ID_KEY = "chalk_mobile_internal_client_id_v1";
const PROD_API_URL = "https://chalk-api.q9labs.ai";
const PROD_WS_URL = "wss://chalk-ws.q9labs.ai/ws";

type JoinContext = {
  joinToken: string;
  roomName?: string;
  accessToken?: string;
  expiresAtMs?: number;
};

export interface MobileDebugContext {
  hostMode: "configured-api-key" | "local-bootstrap" | "internal-bootstrap" | "none";
  configuredHostApiKeyPreview: string | null;
  localDevHostApiKeyPreview: string | null;
  joinTokenPreview: string | null;
  joinAccessTokenPreview: string | null;
  joinTokenClaims: DevDiagnosticsTokenClaimsPreview | null;
  joinAccessTokenClaims: DevDiagnosticsTokenClaimsPreview | null;
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

type JoinTokenExchangeResponse = {
  accessToken: string;
  expiresIn: number;
  roomId?: string | null;
  roomName?: string | null;
};

let cachedHostTokenProvider: (() => Promise<string>) | null = null;
let cachedHostTokenProviderKey: string | null = null;
let cachedLocalDevHostApiKey: string | null | undefined;
let cachedInternalClientID: string | null | undefined;

export function getApiUrl(): string {
  const configured = process.env.EXPO_PUBLIC_API_URL?.trim();
  return resolveAppRuntimeUrl({
    configuredUrl: configured,
    scriptUrl: getReactNativeScriptUrl(),
    fallbackUrl: PROD_API_URL,
    allowDeviceLocal: __DEV__,
  });
}

export function getWsUrl(apiUrl = getApiUrl()): string | undefined {
  const configured = process.env.EXPO_PUBLIC_WS_URL?.trim();
  if (configured) {
    return resolveAppRuntimeUrl({
      configuredUrl: configured,
      scriptUrl: getReactNativeScriptUrl(),
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

function getHostApiKey(): string | null {
  const configured = process.env.EXPO_PUBLIC_CHALK_API_KEY?.trim();
  return configured || null;
}

function canBootstrapLocalHostKey(apiUrl: string, allowDeviceLocal = __DEV__): boolean {
  return canUseLocalHostBootstrap(apiUrl, allowDeviceLocal);
}

export function canCreateMeeting(): boolean {
  return true;
}

async function getOrCreateInternalClientId(): Promise<string> {
  if (cachedInternalClientID !== undefined && cachedInternalClientID !== null) {
    return cachedInternalClientID;
  }

  const existing = await SecureStore.getItemAsync(INTERNAL_CLIENT_ID_KEY);
  if (existing) {
    cachedInternalClientID = existing;
    return existing;
  }

  const next = globalThis.crypto?.randomUUID?.() ?? `chalk-mobile-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  cachedInternalClientID = next;
  await SecureStore.setItemAsync(INTERNAL_CLIENT_ID_KEY, next);
  return next;
}

async function fetchInternalAccessToken(apiUrl: string): Promise<string> {
  const clientId = await getOrCreateInternalClientId();
  const response = await fetch(`${apiUrl}/api/v1/internal/auth/access-token`, {
    method: "GET",
    headers: {
      "X-Chalk-Local-Client-ID": clientId,
    },
  });

  const responseMeta = {
    statusCode: response.status,
    requestId: response.headers?.get?.("x-request-id") ?? null,
    traceId: response.headers?.get?.("x-chalk-trace-id") ?? null,
    cfRay: response.headers?.get?.("cf-ray") ?? null,
  };

  const data = (await response.json().catch(() => null)) as { access_token?: string; error?: string } | null;

  if (!response.ok || !data?.access_token) {
    recordManualRequest({
      eventType: "api.request",
      method: "GET",
      path: "/api/v1/internal/auth/access-token",
      url: `${apiUrl}/api/v1/internal/auth/access-token`,
      outcome: "error",
      statusCode: responseMeta.statusCode,
      requestId: responseMeta.requestId,
      traceId: responseMeta.traceId,
      cfRay: responseMeta.cfRay,
      errorMessage: data?.error ?? `internal auth failed (${response.status})`,
    });
    throw new Error(data?.error ?? `internal auth failed (${response.status})`);
  }

  recordManualRequest({
    eventType: "api.request",
    method: "GET",
    path: "/api/v1/internal/auth/access-token",
    url: `${apiUrl}/api/v1/internal/auth/access-token`,
    outcome: "success",
    statusCode: responseMeta.statusCode,
    requestId: responseMeta.requestId,
    traceId: responseMeta.traceId,
    cfRay: responseMeta.cfRay,
  });

  return data.access_token;
}

function getTokenProviderForKey(apiUrl: string, apiKey: string): () => Promise<string> {
  const cacheKey = `${apiUrl}:${createStorageScopeId(apiUrl, apiKey)}`;
  if (cachedHostTokenProvider && cachedHostTokenProviderKey === cacheKey) {
    return cachedHostTokenProvider;
  }

  cachedHostTokenProvider = createTokenProvider({
    apiKey,
    apiUrl,
    storage: createSecureStoreTokenStorage(apiUrl, apiKey, SecureStore),
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
  if (!canBootstrapLocalHostKey(apiUrl)) {
    throw new Error("Local host bootstrap is disabled for non-local API URLs");
  }

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
  const responseMeta = {
    statusCode: response.status,
    requestId: response.headers?.get?.("x-request-id") ?? null,
    traceId: response.headers?.get?.("x-chalk-trace-id") ?? null,
    cfRay: response.headers?.get?.("cf-ray") ?? null,
  };

  const data = (await response.json().catch(() => null)) as { api_key?: string; error?: string } | null;

  if (!response.ok || !data?.api_key) {
    recordManualRequest({
      eventType: "api.request",
      method: "POST",
      path: "/api/v1/tenants",
      url: `${apiUrl}/api/v1/tenants`,
      outcome: "error",
      statusCode: responseMeta.statusCode,
      requestId: responseMeta.requestId,
      traceId: responseMeta.traceId,
      cfRay: responseMeta.cfRay,
      errorMessage: data?.error ?? "Local host bootstrap failed",
    });
    throw new Error(data?.error ?? "Local host bootstrap failed");
  }

  recordManualRequest({
    eventType: "api.request",
    method: "POST",
    path: "/api/v1/tenants",
    url: `${apiUrl}/api/v1/tenants`,
    outcome: "success",
    statusCode: responseMeta.statusCode,
    requestId: responseMeta.requestId,
    traceId: responseMeta.traceId,
    cfRay: responseMeta.cfRay,
  });
  await setLocalDevHostApiKey(data.api_key);
  return data.api_key;
}

export function getHostTokenProvider(apiUrl: string): (() => Promise<string>) | null {
  const configuredApiKey = getHostApiKey();
  const allowLocalBootstrap = canBootstrapLocalHostKey(apiUrl);

  if (!configuredApiKey && !allowLocalBootstrap) {
    return async () => await fetchInternalAccessToken(apiUrl);
  }

  return async () => {
    let apiKey = configuredApiKey ?? (allowLocalBootstrap ? await getLocalDevHostApiKey() : null);

    if (!apiKey) {
      if (!allowLocalBootstrap) {
        throw new Error("Production mobile host API key is missing.");
      }
      apiKey = await createLocalDevHostApiKey(apiUrl);
    }

    try {
      return await getTokenProviderForKey(apiUrl, apiKey)();
    } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : "";
      const invalidHostKey = message.includes("token exchange failed") || message.includes("invalid api key");

      if (!allowLocalBootstrap) {
        if (invalidHostKey) {
          throw new Error("Production mobile host API key is invalid. Ship a fresh build with the current key.");
        }
        throw error;
      }

      if (!invalidHostKey) {
        throw error;
      }

      apiKey = await createLocalDevHostApiKey(apiUrl);
      return getTokenProviderForKey(apiUrl, apiKey)();
    }
  };
}

async function getJoinContext(): Promise<JoinContext | null> {
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

async function setJoinContext(context: JoinContext): Promise<void> {
  await SecureStore.setItemAsync(JOIN_CONTEXT_KEY, JSON.stringify(context));
}

export async function clearJoinContext(): Promise<void> {
  await SecureStore.deleteItemAsync(JOIN_CONTEXT_KEY);
}

async function clearHostTokenStorage(apiUrl: string, apiKey: string): Promise<void> {
  const storage: NativeTokenStorage = createSecureStoreTokenStorage(apiUrl, apiKey, SecureStore);
  await Promise.all([storage.remove(HOST_ACCESS_TOKEN_KEY), storage.remove(HOST_REFRESH_TOKEN_KEY), storage.remove(HOST_EXPIRES_KEY)]);
}

export async function clearStoredHostAuth(apiUrl: string): Promise<void> {
  const configuredHostApiKey = getHostApiKey();
  const localDevHostApiKey = canBootstrapLocalHostKey(apiUrl) ? await getLocalDevHostApiKey() : null;

  if (configuredHostApiKey) {
    await clearHostTokenStorage(apiUrl, configuredHostApiKey);
  }

  if (localDevHostApiKey) {
    await clearHostTokenStorage(apiUrl, localDevHostApiKey);
    await SecureStore.deleteItemAsync(LOCAL_DEV_HOST_API_KEY_KEY);
    cachedLocalDevHostApiKey = null;
  }

  cachedHostTokenProvider = null;
  cachedHostTokenProviderKey = null;
}

export async function getMobileDebugContext(apiUrl: string): Promise<MobileDebugContext> {
  const configuredHostApiKey = getHostApiKey();
  const localDevHostApiKey = canBootstrapLocalHostKey(apiUrl) ? await getLocalDevHostApiKey() : null;
  const joinContext = await getJoinContext();

  return {
    hostMode: configuredHostApiKey ? "configured-api-key" : localDevHostApiKey ? "local-bootstrap" : "internal-bootstrap",
    configuredHostApiKeyPreview: maskSecret(configuredHostApiKey),
    localDevHostApiKeyPreview: maskSecret(localDevHostApiKey),
    joinTokenPreview: maskSecret(joinContext?.joinToken ?? null),
    joinAccessTokenPreview: maskSecret(joinContext?.accessToken ?? null),
    joinTokenClaims: decodeTokenClaimsPreview(joinContext?.joinToken ?? null),
    joinAccessTokenClaims: decodeTokenClaimsPreview(joinContext?.accessToken ?? null),
    device: getNativeDeviceInfo({
      appVersion: typeof (mobilePackageJson as { version?: string }).version === "string" ? (mobilePackageJson as { version?: string }).version : null,
    }),
  };
}

export async function resolveJoinToken(joinToken: string, apiUrl: string): Promise<LobbyRoute> {
  const response = await fetch(`${apiUrl}/api/v1/public/join-token/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ join_token: joinToken }),
  });
  const responseMeta = {
    statusCode: response.status,
    requestId: response.headers?.get?.("x-request-id") ?? null,
    traceId: response.headers?.get?.("x-chalk-trace-id") ?? null,
    cfRay: response.headers?.get?.("cf-ray") ?? null,
  };
  const data = (await response.json().catch(() => null)) as { access_token?: string; expires_in?: number; room_id?: string | null; room_name?: string | null; error?: string; message?: string } | null;

  if (!response.ok || !data?.access_token || typeof data.expires_in !== "number") {
    recordManualRequest({
      eventType: "api.request",
      method: "POST",
      path: "/api/v1/public/join-token/exchange",
      url: `${apiUrl}/api/v1/public/join-token/exchange`,
      outcome: "error",
      statusCode: responseMeta.statusCode,
      requestId: responseMeta.requestId,
      traceId: responseMeta.traceId,
      cfRay: responseMeta.cfRay,
      errorMessage: data?.message ?? data?.error ?? "Invalid join link",
    });
    throw new Error(data?.message ?? data?.error ?? "Invalid join link");
  }

  recordManualRequest({
    eventType: "api.request",
    method: "POST",
    path: "/api/v1/public/join-token/exchange",
    url: `${apiUrl}/api/v1/public/join-token/exchange`,
    outcome: "success",
    statusCode: responseMeta.statusCode,
    requestId: responseMeta.requestId,
    traceId: responseMeta.traceId,
    cfRay: responseMeta.cfRay,
  });

  const exchanged: JoinTokenExchangeResponse = {
    accessToken: data.access_token,
    expiresIn: data.expires_in,
    roomId: data.room_id,
    roomName: data.room_name,
  };

  const roomId = getCanonicalJoinRoomId(exchanged);
  const roomName = getJoinRoomName(exchanged);

  const context: JoinContext = {
    joinToken,
    roomName,
    accessToken: exchanged.accessToken,
    expiresAtMs: Date.now() + exchanged.expiresIn * 1000,
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

export async function createMeetingLobbyRoute(apiUrl: string, roomName?: string): Promise<LobbyRoute> {
  const getAccessToken = getHostTokenProvider(apiUrl);
  if (!getAccessToken) {
    throw new Error("Meeting creation is currently restricted.");
  }

  const createdRoom = await createHostedMeeting(apiUrl, getAccessToken, roomName);
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
