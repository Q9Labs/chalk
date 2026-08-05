import type { DashboardEpisode } from "../../lib/dashboard-api";
import type { EpisodeStatus } from "./EpisodesPage";

export function readSearchParam(name: string): string | null {
  if (typeof window === "undefined") return null;
  return new URL(window.location.href).searchParams.get(name);
}

export function updateSearch(values: { space?: string | null; episode?: string | null }) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  for (const [name, value] of Object.entries(values)) {
    if (value) url.searchParams.set(name, value);
    else url.searchParams.delete(name);
  }
  window.history.pushState({}, "", url);
}

export function statusLabel(status: EpisodeStatus): string {
  if (status === "active") return "Live now";
  if (status === "ending") return "Ending";
  return "Ended";
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "Not recorded";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Unknown time";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function durationLabel(episode: DashboardEpisode): string {
  if (!episode.ended_at) return "History";
  const duration = Math.max(0, new Date(episode.ended_at).getTime() - new Date(episode.started_at).getTime());
  const minutes = Math.round(duration / 60000);
  return minutes < 1 ? "Less than a minute" : `${minutes} min`;
}

export function humanizeReason(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

export function formatJSON(value: unknown): string {
  if (value === undefined || value === null) return "No values recorded";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "Values unavailable";
  }
}

export function messageForError(cause: unknown, fallback: string): string {
  if (!cause || typeof cause !== "object") return fallback;
  const status = "status" in cause && typeof cause.status === "number" ? cause.status : 0;
  if (status === 401) return "Your Account sign-in has expired. Sign in again to continue.";
  if (status === 403) return "You do not have access to this Episode history.";
  if (status === 429) return "The service is rate-limiting requests. Wait a moment, then try again.";
  if (status >= 500) return "The Episode service is unavailable. Your data was not changed.";
  return "message" in cause && typeof cause.message === "string" ? cause.message : fallback;
}
