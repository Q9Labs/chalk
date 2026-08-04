import type { ChalkSessionAccessProvider, ChalkSessionAccessRequest, ParticipantAccess } from "@q9labsai/chalk-client";

const localBackendPath = "/local-chalk";

export type LocalBrowserAccess = {
  readonly apiBaseURL: string;
  readonly inviteToken?: string;
  readonly syncURL: string;
};

export async function createLocalBrowserAccess(displayName: string, inviteToken?: string): Promise<LocalBrowserAccess> {
  return request<LocalBrowserAccess>("/browser-session", {
    displayName,
    ...(inviteToken ? { inviteToken } : {}),
  });
}

export const createLocalBrowserSession = createLocalBrowserAccess;

export function createLocalAccessProvider(): ChalkSessionAccessProvider {
  return async (input?: ChalkSessionAccessRequest) => {
    return request<ParticipantAccess>("/access", {
      currentMediaToken: input?.currentMediaToken,
      replaceMediaConnection: input?.replaceMediaConnection ?? false,
    });
  };
}

export async function cleanupLocalBrowserSession(): Promise<void> {
  await request<void>("/cleanup");
}

export function beaconLocalBrowserSessionCleanup(): void {
  if (typeof navigator === "undefined" || typeof navigator.sendBeacon !== "function") return;
  navigator.sendBeacon(`${localBackendPath}/cleanup`, new Blob([], { type: "application/json" }));
}

async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${localBackendPath}${path}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });

  if (!response.ok) {
    const message = await errorMessage(response);
    throw new Error(message);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

async function errorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { readonly error?: unknown };
    if (typeof body.error === "string" && body.error.length > 0) return body.error;
  } catch {
    // The HTTP status remains useful when a proxy returns a non-JSON error page.
  }
  return `The Chalk meeting backend returned HTTP ${response.status}`;
}
