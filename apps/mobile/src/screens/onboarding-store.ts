import AsyncStorage from "@react-native-async-storage/async-storage";

export const ONBOARDING_STORAGE_KEY = "chalk.mobile.onboarding.v1";

export interface OnboardingStorage {
  getItem(key: string): Promise<string | null>;
  removeItem(key: string): Promise<void>;
  setItem(key: string, value: string): Promise<void>;
}

export interface OnboardingState {
  completed: boolean;
  displayName: string | null;
}

export interface CompletedOnboardingState {
  completed: true;
  displayName: string | null;
}

export type OnboardingLaunchSurface = "home" | "onboarding";

const EMPTY_ONBOARDING_STATE: OnboardingState = { completed: false, displayName: null };

export function parseOnboardingState(value: string | null): OnboardingState {
  if (!value) return EMPTY_ONBOARDING_STATE;

  try {
    const parsed = JSON.parse(value) as { completed?: unknown; displayName?: unknown };
    if (parsed.completed !== true) return EMPTY_ONBOARDING_STATE;
    const displayName = typeof parsed.displayName === "string" ? parsed.displayName.trim() : "";
    return { completed: true, displayName: displayName || null };
  } catch {
    return EMPTY_ONBOARDING_STATE;
  }
}

export function isOnboardingComplete(value: OnboardingState): value is CompletedOnboardingState {
  return value.completed;
}

export function resolveOnboardingLaunchSurface(value: OnboardingState): OnboardingLaunchSurface {
  return value.completed ? "home" : "onboarding";
}

export async function loadOnboardingState(storage: OnboardingStorage = AsyncStorage): Promise<OnboardingState> {
  return parseOnboardingState(await storage.getItem(ONBOARDING_STORAGE_KEY));
}

export async function saveOnboardingState(displayName: string, storage: OnboardingStorage = AsyncStorage): Promise<CompletedOnboardingState> {
  const normalizedDisplayName = displayName.trim();
  const nextState: CompletedOnboardingState = {
    completed: true,
    displayName: normalizedDisplayName || null,
  };
  await storage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify(nextState));
  return nextState;
}

/** Removing this key mirrors clearing the app's local data and restarts first-run onboarding. */
export async function clearOnboardingState(storage: OnboardingStorage = AsyncStorage): Promise<void> {
  await storage.removeItem(ONBOARDING_STORAGE_KEY);
}
