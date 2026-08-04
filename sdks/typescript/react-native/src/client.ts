/**
 * Native implementation seam for advanced construction. The turnkey root
 * remains `Chalk`; applications that need direct lifecycle ownership can
 * create the React Native SpaceClient through this explicit subpath.
 */
export { createNativeSpaceClient } from "./space-client/create-native-space-client";
export type { NativeSpaceClientOptions } from "./space-client/create-native-space-client";
