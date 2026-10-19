// Node stand-in for expo-crypto's native module, which can't load outside React Native.
export { randomUUID } from "node:crypto";
