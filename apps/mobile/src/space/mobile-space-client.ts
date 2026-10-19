import AsyncStorage from "@react-native-async-storage/async-storage";
import type { GetAccess, SpaceClient } from "@q9labsai/chalk-client";
import { createNativeSpaceClient, type NativeSpaceClientOptions } from "@q9labsai/chalk-react-native/client";

type MobileSpaceClientOptions = {
  readonly apiBaseURL: string;
  readonly defaults: Required<Pick<NativeSpaceClientOptions, "camera" | "microphone">>;
  readonly getAccess: GetAccess;
  readonly space: string;
};

export function createMobileSpaceClient({ apiBaseURL, defaults, getAccess, space }: MobileSpaceClientOptions): SpaceClient {
  return createNativeSpaceClient({
    baseUrl: apiBaseURL,
    camera: defaults.camera,
    getAccess,
    microphone: defaults.microphone,
    space,
    storage: AsyncStorage,
  });
}

export type MobileSpaceClientOwner = {
  readonly release: () => Promise<void>;
};

/** Releases a supplied client exactly once. Chalk only disposes clients it creates itself. */
export function ownMobileSpaceClient(client: SpaceClient): MobileSpaceClientOwner {
  let released = false;

  return {
    async release() {
      if (released) return;
      released = true;

      try {
        if (client.getSnapshot().connection.status !== "left") await client.leave();
      } catch {
        // Disposal must still release device resources after a failed leave.
      } finally {
        client.dispose();
      }
    },
  };
}
