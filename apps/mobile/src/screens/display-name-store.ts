import AsyncStorage from "@react-native-async-storage/async-storage";

// The key and its JSON shape date from the retired onboarding flow; stored names must keep loading.
export const DISPLAY_NAME_MAX_LENGTH = 40;

const DISPLAY_NAME_STORAGE_KEY = "chalk.mobile.onboarding.v1";

export function parseDisplayName(value: string | null): string | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as { displayName?: unknown };
    const displayName = typeof parsed.displayName === "string" ? parsed.displayName.trim() : "";
    return displayName || null;
  } catch {
    return null;
  }
}

export async function loadDisplayName(): Promise<string | null> {
  return parseDisplayName(await AsyncStorage.getItem(DISPLAY_NAME_STORAGE_KEY));
}

export async function saveDisplayName(displayName: string): Promise<void> {
  await AsyncStorage.setItem(DISPLAY_NAME_STORAGE_KEY, JSON.stringify({ completed: true, displayName: displayName.trim() }));
}
