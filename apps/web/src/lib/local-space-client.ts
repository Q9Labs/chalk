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
      ...(credential.syncDirectURL ? { syncDirectUrl: credential.syncDirectURL } : {}),
      ...(credential.directPath ? { directPath: credential.directPath } : {}),
      ...(connectionAccess ? { connectionAccess } : {}),
    },
  );
  return client;
}
/** Releasing is safe from both the public client's leave callback and React unmount cleanup. A failed `cleanup` can be tried again. */
export function createLocalSpaceRelease(client: Pick<SpaceClient, "close">, cleanup: () => Promise<void>): () => Promise<void> {
  let releasePromise: Promise<void> | undefined;
  return () => {
    releasePromise ??= client
      .close()
      .then(cleanup)
      .catch((cause: unknown) => {
        releasePromise = undefined;
        throw cause;
      });
    return releasePromise;
  };
}
