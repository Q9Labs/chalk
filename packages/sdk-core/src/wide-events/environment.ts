/**
 * Environment detection for wide events
 *
 * @packageDocumentation
 * @module @q9labs/chalk-core/wide-events
 */

import type { WideEventPlatform, WideEventSdk } from "./types";
import packageJson from "../../package.json";
import { createRandomId } from "../utils/random-id.ts";

/** SDK version - sourced from package.json at build time */
const SDK_VERSION = packageJson.version;

/**
 * Detect the current platform
 */
export function detectPlatform(): WideEventPlatform {
  // React Native detection
  if (typeof navigator !== "undefined" && navigator.product === "ReactNative") {
    return "react-native";
  }

  // Browser detection
  if (typeof window !== "undefined" && typeof document !== "undefined") {
    return "browser";
  }

  // Node.js / SSR
  return "node";
}

/**
 * Get user agent string (browser only)
 */
export function getUserAgent(): string | undefined {
  if (typeof navigator !== "undefined" && navigator.userAgent) {
    return navigator.userAgent;
  }
  return undefined;
}

/**
 * Get SDK environment information
 */
export function getSdkEnvironment(): WideEventSdk {
  return {
    version: SDK_VERSION,
    platform: detectPlatform(),
    userAgent: getUserAgent(),
  };
}

/**
 * Generate a unique session ID
 */
export function generateSessionId(): string {
  return createRandomId();
}

/**
 * Generate a unique event ID
 */
export function generateEventId(): string {
  return generateSessionId();
}
