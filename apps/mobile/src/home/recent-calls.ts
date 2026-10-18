import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCallback, useEffect, useState } from "react";

export const RECENT_CALLS_STORAGE_KEY = "chalk.mobile.recent-calls.v1";
const MAX_RECENT_CALLS = 20;

/** A call this device joined, kept on the device only. `link` is the full invite link and identifies the call. */
export type RecentCall = {
  readonly link: string;
  readonly name: string;
  readonly joinedAt: number;
  /** Up to three other people seen in the call, for the row's faces. */
  readonly people: readonly string[];
};

export function parseRecentCalls(value: string | null): readonly RecentCall[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter(isRecentCall) : [];
  } catch {
    return [];
  }
}

function isRecentCall(value: unknown): value is RecentCall {
  if (typeof value !== "object" || value === null) return false;
  if (!("link" in value) || !("name" in value) || !("joinedAt" in value) || !("people" in value)) return false;
  return typeof value.link === "string" && typeof value.name === "string" && typeof value.joinedAt === "number" && Array.isArray(value.people) && value.people.every((person) => typeof person === "string");
}

/** Puts `call` first, replacing any earlier entry for the same link. */
export function withRecentCall(calls: readonly RecentCall[], call: RecentCall): readonly RecentCall[] {
  return [call, ...calls.filter((entry) => entry.link !== call.link)].slice(0, MAX_RECENT_CALLS);
}

/** "Today, 10:02", "Yesterday, 16:30", a weekday within the last week, then "12 Oct". */
export function formatJoinedAt(joinedAt: number, now = Date.now()): string {
  const date = new Date(joinedAt);
  const days = Math.round((startOfDay(now) - startOfDay(joinedAt)) / 86_400_000);
  const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (days <= 0) return `Today, ${time}`;
  if (days === 1) return `Yesterday, ${time}`;
  if (days < 7) return date.toLocaleDateString(undefined, { weekday: "long" });
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function startOfDay(time: number): number {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export type RecentCalls = {
  readonly calls: readonly RecentCall[];
  readonly remember: (call: RecentCall) => void;
  /** Removes the call and returns what puts it back where it was. */
  readonly remove: (link: string) => () => void;
};

/** The device's recent calls, or `null` while they load. Every change is saved at once. */
export function useRecentCalls(onError: (cause: unknown) => void): RecentCalls | null {
  const [calls, setCalls] = useState<readonly RecentCall[] | null>(null);

  useEffect(() => {
    let mounted = true;
    void AsyncStorage.getItem(RECENT_CALLS_STORAGE_KEY)
      .then(parseRecentCalls)
      .catch((cause: unknown) => {
        onError(cause);
        return [];
      })
      .then((loaded) => {
        if (mounted) setCalls(loaded);
      });
    return () => {
      mounted = false;
    };
  }, [onError]);

  const update = useCallback(
    (change: (current: readonly RecentCall[]) => readonly RecentCall[]) => {
      setCalls((current) => {
        const next = change(current ?? []);
        AsyncStorage.setItem(RECENT_CALLS_STORAGE_KEY, JSON.stringify(next)).catch(onError);
        return next;
      });
    },
    [onError],
  );
  const remember = useCallback((call: RecentCall) => update((current) => withRecentCall(current, call)), [update]);
  const remove = useCallback(
    (link: string) => {
      let removed: { readonly call: RecentCall; readonly index: number } | null = null;
      update((current) => {
        const index = current.findIndex((entry) => entry.link === link);
        const call = current[index];
        if (!call) return current;
        removed = { call, index };
        return current.filter((entry) => entry.link !== link);
      });
      return () => {
        const restored = removed;
        if (!restored) return;
        update((current) => (current.some((entry) => entry.link === link) ? current : [...current.slice(0, restored.index), restored.call, ...current.slice(restored.index)]));
      };
    },
    [update],
  );

  return calls ? { calls, remember, remove } : null;
}
