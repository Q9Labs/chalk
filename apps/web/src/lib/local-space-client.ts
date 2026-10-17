import type { GetAccess, SpaceClient, SpaceClientOptions } from "@q9labsai/chalk-client";
import { createSpaceClientForPlatform, type SpaceClientPlatform } from "@q9labsai/chalk-client/effect";
import type { PublicSpaceCredential } from "./chalk-access";
type CreateSpaceClient = (options: SpaceClientOptions, platform: SpaceClientPlatform) => SpaceClient;
export type LocalSpaceClientOptions = {
  readonly credential: PublicSpaceCredential;
  readonly getAccess: GetAccess;
  readonly connectionAccess?: SpaceClientPlatform["connectionAccess"];
};
type LocalSpaceClientDependencies = {
  readonly createSpaceClient?: CreateSpaceClient;
};
/** Creates the app-owned Space client with the verified Space identity and access provider. */
export function createLocalSpaceClient({ credential, getAccess, connectionAccess }: LocalSpaceClientOptions, dependencies: LocalSpaceClientDependencies = {}): SpaceClient {
  const syncURL = credential.syncURL;
  const client = (dependencies.createSpaceClient ?? createSpaceClientForPlatform)(
    { space: credential.space, getAccess, baseUrl: credential.apiBaseURL },
    {
      ...(syncURL ? { syncUrl: syncURL } : {}),
      ...(connectionAccess ? { connectionAccess } : {}),
    },
  );
  return client;
}
/** Releasing is safe from both the public client's leave callback and React unmount cleanup. */
export function createLocalSpaceRelease(client: Pick<SpaceClient, "leave" | "dispose">, cleanup: () => Promise<void>): () => Promise<void> {
  let releasePromise: Promise<void> | undefined;
  return () => {
    if (releasePromise) return releasePromise;
    releasePromise = releaseOnce(client, cleanup).catch((cause: unknown) => {
      releasePromise = undefined;
      throw cause;
    });
    return releasePromise;
  };
}
async function releaseOnce(client: Pick<SpaceClient, "leave" | "dispose">, cleanup: () => Promise<void>): Promise<void> {
  try {
    await client.leave();
  } catch {
    // Arrival cleanup still has to run when transport shutdown is already in progress.
  }
  try {
    client.dispose();
  } catch {
    // Cleanup remains authoritative when the SDK disposal hook is already closed.
  }
  await cleanup();
}
