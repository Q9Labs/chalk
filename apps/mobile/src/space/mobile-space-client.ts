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
