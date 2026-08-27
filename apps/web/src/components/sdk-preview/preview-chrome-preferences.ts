/**
 * Local, per-browser preferences for the preview controls chrome. These are
 * deliberately not part of the URL: a shared preview link should not dictate
 * where another developer docks the panel or which tab they were on.
 */

const PREVIEW_DOCK_SIDES = ["left", "right"] as const;
export type PreviewDockSide = (typeof PREVIEW_DOCK_SIDES)[number];

export const PREVIEW_CONTROL_TABS = ["states", "space", "media", "access", "look"] as const;
export type PreviewControlTab = (typeof PREVIEW_CONTROL_TABS)[number];

const DOCK_KEY = "chalk.sdk-preview.dock";
const TAB_KEY = "chalk.sdk-preview.tab";

function preferenceStorage(): Storage | undefined {
  return typeof window === "undefined" ? undefined : window.localStorage;
}

function readPreference<T extends string>(name: string, options: readonly T[], fallback: T): T {
  const stored = preferenceStorage()?.getItem(name);
  return options.find((option) => option === stored) ?? fallback;
}

function writePreference(name: string, value: string): void {
  preferenceStorage()?.setItem(name, value);
}

export function readPreviewDockSide(): PreviewDockSide {
  return readPreference(DOCK_KEY, PREVIEW_DOCK_SIDES, "left");
}

export function storePreviewDockSide(side: PreviewDockSide): void {
  writePreference(DOCK_KEY, side);
}

export function readPreviewControlTab(): PreviewControlTab {
  return readPreference(TAB_KEY, PREVIEW_CONTROL_TABS, "states");
}

export function storePreviewControlTab(tab: PreviewControlTab): void {
  writePreference(TAB_KEY, tab);
}
