import * as SecureStore from "expo-secure-store";
import type { TokenStorage } from "./mobile-auth";
import { createStorageScopeId } from "./mobile-runtime";

export const LEGACY_HOST_TOKEN_PREFIXES = ["chalk_mobile_host_token_", "chalk_mobile_host_token_v2_"];
export const HOST_ACCESS_TOKEN_KEY = "chalk_access_token";
export const HOST_REFRESH_TOKEN_KEY = "chalk_refresh_token";
export const HOST_EXPIRES_KEY = "chalk_token_expires";

const HOST_TOKEN_STORAGE_VERSION = "v3";

export function createHostTokenStorage(apiUrl: string, apiKey: string): TokenStorage {
  const scopeId = createStorageScopeId(apiUrl, apiKey);
  const prefix = `chalk_mobile_host_token_${HOST_TOKEN_STORAGE_VERSION}_${scopeId}_`;

  return {
    get: async (key) => SecureStore.getItemAsync(`${prefix}${key}`),
    set: async (key, value) => {
      await SecureStore.setItemAsync(`${prefix}${key}`, value);
    },
    remove: async (key) => {
      await SecureStore.deleteItemAsync(`${prefix}${key}`);
    },
  };
}
