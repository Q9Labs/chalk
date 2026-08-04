import mobilePackageJson from "../../package.json";
import type { AccessGrant, GetAccess } from "@q9labsai/chalk-client";
import * as SecureStore from "expo-secure-store";

import { getDeviceInfo } from "@q9labsai/chalk-react-native/runtime";

export { getBrokerUrl, isMobileTelemetryEnabled } from "./mobile-config";

const PARTICIPANT_CREDENTIAL_PREFIX = "chalk_mobile_participant_credential_v4.";
const LAST_SPACE_INVITE_KEY = "chalk_mobile_last_space_invite_v4";
const PUBLIC_SPACE_SLUG = "local-space";
const CHALK_LINK_HOSTS = new Set(["chalkmeet.com", "chalk.q9labs.ai"]);
const CHALK_PROTOCOLS = new Set(["chalk:", "ai.q9labs.chalk.mobile:"]);
const capabilityPattern = /^[A-Za-z0-9_-]{43}$/u;
const PUBLIC_SPACE_ORIGIN = "https://chalkmeet.com";

export type MobileRoute = { readonly kind: "home" } | SpaceRoute;

export type SpaceRoute = {
  readonly kind: "space";
  readonly space: typeof PUBLIC_SPACE_SLUG;
  readonly spaceInviteToken?: string;
  readonly spaceName?: string;
  readonly source: "local-space" | "space-link";
};

export type ParticipantCredential = {
  readonly apiBaseURL: string;
  readonly participantCredentialId: string;
  readonly spaceInviteToken: string;
  readonly syncURL: string;
};

export type MobileDeviceContext = {
  readonly device: ReturnType<typeof getDeviceInfo>;
};

export type ParticipantCredentialRequest = {
  readonly brokerUrl: string;
  readonly displayName: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly spaceInviteToken?: string;
};

export async function enterLocalSpaceRoute(spaceName?: string): Promise<SpaceRoute> {
  return {
    kind: "space",
    space: PUBLIC_SPACE_SLUG,
    spaceName: spaceName?.trim() || undefined,
    source: "local-space",
  };
}

export async function resolveSpaceInvite(spaceInviteToken: string): Promise<SpaceRoute> {
  return {
    kind: "space",
    space: PUBLIC_SPACE_SLUG,
    spaceInviteToken,
    source: "space-link",
  };
}

export function parseSpaceLink(input: string): SpaceRoute | null {
  const parsed = parseChalkLink(input);
  if (!parsed || pathFor(parsed) !== "/space") return null;

  const spaceInviteToken = new URLSearchParams(parsed.hash.slice(1)).get("spaceInviteToken")?.trim();
  return spaceInviteToken && capabilityPattern.test(spaceInviteToken) ? { kind: "space", space: PUBLIC_SPACE_SLUG, spaceInviteToken, source: "space-link" } : null;
}

export function spaceInviteLink(spaceInviteToken: string): string {
  const link = new URL("/space", PUBLIC_SPACE_ORIGIN);
  link.hash = new URLSearchParams({ spaceInviteToken }).toString();
  return link.toString();
}

export function getClipboardSpaceSuggestion(clipboardText: string | null | undefined, currentInput = ""): string | null {
  const candidate = clipboardText?.trim();
  if (!candidate || candidate === currentInput.trim()) return null;
  return parseSpaceLink(candidate) ? candidate : null;
}

export async function prepareParticipantCredential(input: ParticipantCredentialRequest): Promise<ParticipantCredential> {
  const stored = input.spaceInviteToken ? await loadParticipantCredential(input.spaceInviteToken) : undefined;

  try {
    return await createParticipantCredential({ ...input, ...(stored ? { participantCredentialId: stored.participantCredentialId } : {}) });
  } catch (error) {
    if (!stored || !isExpiredCredentialError(error)) throw error;
    await clearParticipantCredential(stored.spaceInviteToken);
    return createParticipantCredential(input);
  }
}

export function createAccessGrantGetter({ brokerUrl, credential, headers }: { readonly brokerUrl: string; readonly credential: ParticipantCredential; readonly headers?: Readonly<Record<string, string>> }): GetAccess {
  return async ({ reason }) => {
    const response = await fetch(`${brokerUrl}/access-grants`, {
      body: JSON.stringify({
        participantCredentialId: credential.participantCredentialId,
        replaceMediaConnection: reason === "retry",
        spaceInviteToken: credential.spaceInviteToken,
      }),
      headers: { "content-type": "application/json", ...headers },
      method: "POST",
    });
    if (!response.ok) throw await brokerError(response);

    return (await response.json()) as AccessGrant;
  };
}

export async function cleanupParticipantCredential({ brokerUrl, credential, headers }: { readonly brokerUrl: string; readonly credential: ParticipantCredential; readonly headers?: Readonly<Record<string, string>> }): Promise<void> {
  const response = await fetch(`${brokerUrl}/participant-credentials/cleanup`, {
    body: JSON.stringify({
      participantCredentialId: credential.participantCredentialId,
      spaceInviteToken: credential.spaceInviteToken,
    }),
    headers: { "content-type": "application/json", ...headers },
    method: "POST",
  });
  if (!response.ok && !isTerminalCleanupStatus(response.status)) throw await brokerError(response);
  if (response.ok || isTerminalCleanupStatus(response.status)) {
    await clearParticipantCredential(credential.spaceInviteToken);
  }
}

export async function clearSpaceContext(): Promise<void> {
  const spaceInviteToken = await SecureStore.getItemAsync(LAST_SPACE_INVITE_KEY);
  await Promise.all([...(spaceInviteToken ? [SecureStore.deleteItemAsync(credentialKey(spaceInviteToken))] : []), SecureStore.deleteItemAsync(LAST_SPACE_INVITE_KEY)]);
}

export function getMobileDeviceContext(): MobileDeviceContext {
  return {
    device: getDeviceInfo({
      appVersion: typeof (mobilePackageJson as { readonly version?: unknown }).version === "string" ? (mobilePackageJson as { readonly version: string }).version : null,
    }),
  };
}

async function createParticipantCredential(input: ParticipantCredentialRequest & { readonly participantCredentialId?: string }): Promise<ParticipantCredential> {
  const response = await fetch(`${input.brokerUrl}/participant-credentials`, {
    body: JSON.stringify({
      displayName: input.displayName,
      ...(input.participantCredentialId ? { participantCredentialId: input.participantCredentialId } : {}),
      ...(input.spaceInviteToken ? { spaceInviteToken: input.spaceInviteToken } : {}),
    }),
    headers: { "content-type": "application/json", ...input.headers },
    method: "POST",
  });
  if (!response.ok) throw await brokerError(response);

  const credential = participantCredential(await response.json());
  await Promise.all([SecureStore.setItemAsync(credentialKey(credential.spaceInviteToken), JSON.stringify(credential)), SecureStore.setItemAsync(LAST_SPACE_INVITE_KEY, credential.spaceInviteToken)]);
  return credential;
}

async function loadParticipantCredential(spaceInviteToken: string): Promise<ParticipantCredential | undefined> {
  const value = await SecureStore.getItemAsync(credentialKey(spaceInviteToken));
  if (!value) return undefined;

  try {
    const credential = participantCredential(JSON.parse(value));
    if (credential.spaceInviteToken === spaceInviteToken) return credential;
  } catch {
    // Invalid device state is removed below.
  }

  await clearParticipantCredential(spaceInviteToken);
  return undefined;
}

async function clearParticipantCredential(spaceInviteToken: string): Promise<void> {
  const lastSpaceInviteToken = await SecureStore.getItemAsync(LAST_SPACE_INVITE_KEY);
  await Promise.all([SecureStore.deleteItemAsync(credentialKey(spaceInviteToken)), ...(lastSpaceInviteToken === spaceInviteToken ? [SecureStore.deleteItemAsync(LAST_SPACE_INVITE_KEY)] : [])]);
}

function participantCredential(value: unknown): ParticipantCredential {
  if (!isRecord(value) || !capability(value.participantCredentialId) || !capability(value.spaceInviteToken) || !url(value.apiBaseURL, ["http:", "https:"]) || !url(value.syncURL, ["ws:", "wss:"])) {
    throw new TypeError("Participant credential is invalid.");
  }
  return {
    apiBaseURL: value.apiBaseURL,
    participantCredentialId: value.participantCredentialId,
    spaceInviteToken: value.spaceInviteToken,
    syncURL: value.syncURL,
  };
}

async function brokerError(response: Response): Promise<BrokerError> {
  const message = (await response.text()).trim();
  return new BrokerError(response.status, message || `Access request failed with HTTP ${response.status}.`);
}

class BrokerError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "BrokerError";
  }
}

function isExpiredCredentialError(error: unknown): error is BrokerError {
  return error instanceof BrokerError && [401, 404, 410].includes(error.status);
}

function isTerminalCleanupStatus(status: number): boolean {
  return status === 401 || status === 404 || status === 410;
}

function parseChalkLink(input: string): URL | null {
  const value = input.trim();
  if (!value) return null;
  const normalized = value.includes("://") ? value : CHALK_LINK_HOSTS.has(value.split("/", 1)[0] ?? "") ? `https://${value}` : null;
  if (!normalized) return null;

  try {
    const parsed = new URL(normalized);
    if (CHALK_PROTOCOLS.has(parsed.protocol)) return parsed;
    return parsed.protocol === "https:" && CHALK_LINK_HOSTS.has(parsed.hostname) ? parsed : null;
  } catch {
    return null;
  }
}

function pathFor(url: URL): string {
  return CHALK_PROTOCOLS.has(url.protocol) ? `/${url.hostname}${url.pathname}` : url.pathname;
}

function credentialKey(spaceInviteToken: string): string {
  return `${PARTICIPANT_CREDENTIAL_PREFIX}${spaceInviteToken}`;
}

function capability(value: unknown): value is string {
  return typeof value === "string" && capabilityPattern.test(value);
}

function url(value: unknown, protocols: readonly string[]): value is string {
  if (typeof value !== "string") return false;

  try {
    const parsed = new URL(value);
    return protocols.includes(parsed.protocol) && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
