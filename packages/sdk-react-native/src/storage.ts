import { createStorageScopeId } from "./utils/storage-scope";

export interface NativeKeyValueStorage {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
}

export interface NativeTokenStorage {
  get(key: string): string | null | Promise<string | null>;
  set(key: string, value: string): void | Promise<void>;
  remove(key: string): void | Promise<void>;
}

export const LEGACY_HOST_TOKEN_PREFIXES = ["chalk_mobile_host_token_", "chalk_mobile_host_token_v2_"];
export const HOST_ACCESS_TOKEN_KEY = "chalk_access_token";
export const HOST_REFRESH_TOKEN_KEY = "chalk_refresh_token";
export const HOST_EXPIRES_KEY = "chalk_token_expires";

const HOST_TOKEN_STORAGE_VERSION = "v3";

export function createSecureStoreTokenStorage(apiUrl: string, apiKey: string, secureStore: NativeKeyValueStorage): NativeTokenStorage {
  const scopeId = createStorageScopeId(apiUrl, apiKey);
  const prefix = `chalk_mobile_host_token_${HOST_TOKEN_STORAGE_VERSION}_${scopeId}_`;

  return {
    get: async (key) => secureStore.getItemAsync(`${prefix}${key}`),
    set: async (key, value) => {
      await secureStore.setItemAsync(`${prefix}${key}`, value);
    },
    remove: async (key) => {
      await secureStore.deleteItemAsync(`${prefix}${key}`);
    },
  };
}
