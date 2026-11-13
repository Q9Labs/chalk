// Dashboard dates keep day before month; clock times use AM/PM in the viewer's time zone.
import { formatClockTime } from "@q9labsai/chalk-react/utils";

const DAY = 86400000;
const weekdayShort = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short" });
const weekdayLong = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long" });
const weekdayYear = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
const dayMonth = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });
const dayMonthYear = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });

const startOfDay = (value: number) => {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
};
const daysBefore = (iso: string, now: number) => Math.round((startOfDay(now) - startOfDay(Date.parse(iso))) / DAY);

/** 10:02 AM */
export function clock(iso: string): string {
  return formatClockTime(iso);
}

/** "Today", "Yesterday", then "Thu 15 Oct". */
export function sessionDay(iso: string, now = Date.now()): string {
  const days = daysBefore(iso, now);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return weekdayShort.format(new Date(iso)).replace(",", "").replace("Sept", "Sep");
}

/**
 * When a call was last used: "Today, 10:02 AM" and "Yesterday, 4:30 PM", then always a day and a date, "Thu 5 Nov", with
 * the year only once it isn't this year, "Wed 2 Sep 2025". A bare weekday hid which week it meant.
 */
export function lastActive(iso: string, now = Date.now()): string {
  const days = daysBefore(iso, now);
  if (days === 0) return `Today, ${clock(iso)}`;
  if (days === 1) return `Yesterday, ${clock(iso)}`;
  const date = new Date(iso);
  const format = date.getFullYear() === new Date(now).getFullYear() ? weekdayShort : weekdayYear;
  return format.format(date).replace(",", "").replace("Sept", "Sep");
}

/**
 * A new call's name until someone renames it, "Call on Fri 13 Nov, 2:05 PM", so calls started the same day still read
 * apart on Home.
 */
export function newCallName(now = Date.now()): string {
  const iso = new Date(now).toISOString();
  return `Call on ${weekdayShort.format(new Date(now)).replace(",", "").replace("Sept", "Sep")}, ${clock(iso)}`;
}

/** How long ago, roughly: "Just now", "2 minutes ago", "Yesterday", "3 weeks ago", then the date. */
export function ago(iso: string, now = Date.now()): string {
  const minutes = Math.floor((now - Date.parse(iso)) / 60000);
  const days = daysBefore(iso, now);
  const plural = (count: number, unit: string) => `${count} ${unit}${count === 1 ? "" : "s"} ago`;
  if (minutes < 1) return "Just now";
  if (minutes < 60) return plural(minutes, "minute");
  if (days === 0) return plural(Math.floor(minutes / 60), "hour");
  if (days === 1) return "Yesterday";
  if (days < 7) return plural(days, "day");
  if (days < 35) return plural(Math.floor(days / 7), "week");
  return shortDate(iso, now);
}

/** "Sunday 18 October" */
export function longDay(iso: string): string {
  return weekdayLong.format(new Date(iso)).replace(",", "");
}

/** "12 Oct" this year, "2 Sep 2027" otherwise. */
function shortDate(iso: string, now = Date.now()): string {
  const date = new Date(iso);
  return (date.getFullYear() === new Date(now).getFullYear() ? dayMonth.format(date) : dayMonthYear.format(date)).replace("Sept", "Sep");
}

/** "2 Sep 2027" */
export function fullDate(iso: string): string {
  return dayMonthYear.format(new Date(iso)).replace("Sept", "Sep");
}

/** Whole minutes between two instants: "46 min", "1 h 5 min". */
export function duration(fromISO: string, toISO: string): string {
  const minutes = Math.max(0, Math.round((Date.parse(toISO) - Date.parse(fromISO)) / 60000));
  if (minutes < 60) return `${minutes} min`;
  const rest = minutes % 60;
  return rest ? `${Math.floor(minutes / 60)} h ${rest} min` : `${minutes / 60} h`;
}

/** True once a key's expiry has passed. */
export function hasExpired(iso: string, now = Date.now()): boolean {
  return Date.parse(iso) <= now;
}

/** "in 5 days" when an expiry is within a week, otherwise undefined. "today" and "tomorrow" read better than numbers. */
export function expiresSoon(iso: string, now = Date.now()): string | undefined {
  const days = -daysBefore(iso, now);
  if (days < 0 || days > 7) return undefined;
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  return `in ${days} days`;
}

/** 01:32, or 1:01:32 past an hour. */
export function playbackTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const pad = (value: number) => String(value).padStart(2, "0");
  const hours = Math.floor(total / 3600);
  const rest = `${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
  return hours ? `${hours}:${rest}` : rest;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "0.0.0.0"]);
const isLoopback = (url: URL) => LOOPBACK.has(url.hostname) || url.hostname.endsWith(".localhost");

/** True when a link names this machine (localhost, 127.0.0.1) while the page itself is served from a real address. */
export function isInternalLink(url: string, page: string = window.location.href): boolean {
  try {
    return isLoopback(new URL(url)) && !isLoopback(new URL(page));
  } catch {
    return false;
  }
}

/**
 * A call link people can open. A test server that only knows its own loopback address hands out 127.0.0.1 links; the
 * dashboard serves the call page too, so the same path on the page's own origin is the link people can use.
 */
export function shareableLink(url: string, page: string = window.location.href): string {
  if (!isInternalLink(url, page)) return url;
  const link = new URL(url);
  const origin = new URL(page).origin;
  return `${origin}${link.pathname}${link.search}${link.hash}`;
}

/** The link as people read it: no scheme, no invite secret. */
export function displayLink(url: string): string {
  const { host, path } = linkParts(url);
  return host + path;
}

/** The link's host and the path that names what it opens, as people read them. */
export function linkParts(url: string): { readonly host: string; readonly path: string } {
  try {
    const parsed = new URL(url);
    return { host: parsed.host, path: parsed.pathname.replace(/\/$/, "") };
  } catch {
    return { host: url, path: "" };
  }
}
