import Storage from "expo-sqlite/kv-store";
import * as SecureStore from "expo-secure-store";
import { APP_STORAGE_KEY, GROQ_API_KEY_STORAGE_KEY } from "./constants";
import { createEmptyState, type HeadquartersState } from "./models";

export async function loadHeadquartersState() {
  const rawState = await Storage.getItem(APP_STORAGE_KEY);

  if (!rawState) {
    return createEmptyState();
  }

  try {
    const parsed = JSON.parse(rawState);
    return {
      ...createEmptyState(),
      ...parsed,
      recordings: Array.isArray(parsed.recordings) ? parsed.recordings : [],
    } satisfies HeadquartersState;
  } catch {
    return createEmptyState();
  }
}

export async function saveHeadquartersState(state: HeadquartersState) {
  await Storage.setItem(APP_STORAGE_KEY, JSON.stringify(state));
}

export async function loadGroqApiKey() {
  return (await SecureStore.getItemAsync(GROQ_API_KEY_STORAGE_KEY))?.trim() ?? "";
}

export async function saveGroqApiKey(apiKey: string) {
  const trimmedKey = apiKey.trim();

  if (!trimmedKey) {
    await SecureStore.deleteItemAsync(GROQ_API_KEY_STORAGE_KEY);
    return;
  }

  await SecureStore.setItemAsync(GROQ_API_KEY_STORAGE_KEY, trimmedKey);
}
