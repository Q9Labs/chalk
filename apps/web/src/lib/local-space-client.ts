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
/** Creates the app-owned Space client with the verified Space identity and the arrival's access. */
export function createLocalSpaceClient({ credential, getAccess, connectionAccess }: LocalSpaceClientOptions, dependencies: LocalSpaceClientDependencies = {}): SpaceClient {
  return (dependencies.createSpaceClient ?? createSpaceClientForPlatform)(
    { space: credential.space, getAccess, baseUrl: credential.apiBaseURL },
    {
      syncUrl: credential.syncURL,
      ...(connectionAccess ? { connectionAccess } : {}),
      ...(credential.syncDirectURL ? { syncDirectUrl: credential.syncDirectURL } : {}),
      ...(credential.directPath ? { directPath: credential.directPath } : {}),
    },
  );
}
