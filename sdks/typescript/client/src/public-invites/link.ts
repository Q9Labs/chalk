import { parseInviteCode } from "./code.js";
import { inviteCodeByShape } from "./code-shape.js";

/** Hosts whose links open a Chalk call. A deployment with another web host passes its own list. */
export const INVITE_HOSTS: readonly string[] = ["chalkmeet.com", "chalk.q9labs.ai"];
export const DEFAULT_INVITE_ORIGIN = "https://chalkmeet.com";
const APP_PROTOCOLS: ReadonlySet<string> = new Set(["chalk:", "ai.q9labs.chalk.mobile:"]);
const SPACE_SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const SPACE_INVITE_TOKEN_PATTERN = /^cspi1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;
const SPACE_INVITE_TOKEN_KEY = "spaceInviteToken";

export type SpaceInviteLink = {
  readonly slug: string;
  readonly spaceInviteToken: string;
};

/** A link names a Space by its short code alone, or by slug plus capability token. */
export type ChalkInviteLink = {
  readonly slug?: string;
  readonly spaceInviteToken: string;
};

export type InviteLinkOptions = {
  readonly hosts?: readonly string[];
};

/** The long form: `<origin>/space/<slug>#spaceInviteToken=<token>`. */
export function buildSpaceInviteLink(slug: string, spaceInviteToken: string, origin: string = DEFAULT_INVITE_ORIGIN): string {
  const link = new URL(`/space/${encodeURIComponent(slug)}`, origin);
  link.hash = new URLSearchParams({ [SPACE_INVITE_TOKEN_KEY]: spaceInviteToken }).toString();
  return link.toString();
}

/** The short form: `<origin>/<code>`. */
export function buildInviteCodeLink(code: string, origin: string = DEFAULT_INVITE_ORIGIN): string {
  return new URL(`/${code}`, origin).toString();
}

/** The capability token in a long-form link's fragment, without checking the rest of the link. */
export function readSpaceInviteToken(hash: string): string | undefined {
  return new URLSearchParams(hash.replace(/^#/u, "")).get(SPACE_INVITE_TOKEN_KEY)?.trim() || undefined;
}

export function parseSpaceInviteLink(input: string, options: InviteLinkOptions = {}): SpaceInviteLink | null {
  const path = invitePath(input, options.hosts ?? INVITE_HOSTS);
  if (path?.segments.length !== 2 || path.segments[0] !== "space") return null;
  const slug = path.segments[1];
  const token = readSpaceInviteToken(path.hash);
  return slug && token && token.length <= 512 && SPACE_SLUG_PATTERN.test(slug) && SPACE_INVITE_TOKEN_PATTERN.test(token) ? { slug, spaceInviteToken: token } : null;
}

export function parseChalkInviteLink(input: string, options: InviteLinkOptions = {}): ChalkInviteLink | null {
  const trimmed = input.trim();
  const code = parseInviteCode(trimmed);
  if (code) return { spaceInviteToken: code };

  const long = parseSpaceInviteLink(trimmed, options);
  if (long) return long;

  const path = invitePath(trimmed, options.hosts ?? INVITE_HOSTS);
  if (path?.segments.length !== 1 || path.search || path.hash) return null;
  try {
    const pathCode = parseInviteCode(decodeURIComponent(path.segments[0] ?? ""));
    return pathCode ? { spaceInviteToken: pathCode } : null;
  } catch {
    return null;
  }
}

/** The link to show and share for a Space entered with `credential`, which is a short code, a link on `origin` or a bare capability token. */
export function canonicalSpaceInviteLink(origin: string, slug: string, credential: string): string {
  const value = credential.trim();
  if (!value) throw new Error("The Space invite link was empty.");

  const code = inviteCodeByShape(value);
  if (code) return buildInviteCodeLink(code, origin);
  let parsed: URL | undefined;
  try {
    parsed = new URL(value, origin);
  } catch {
    parsed = undefined;
  }
  if (parsed && parsed.origin !== new URL(origin).origin) throw new Error("The Space invite link used an unexpected origin.");
  if (parsed?.hash.includes(`${SPACE_INVITE_TOKEN_KEY}=`)) return parsed.toString();
  return buildSpaceInviteLink(slug, value, origin);
}

/** Returns `inviteLink` when it names this Space on `origin` with a valid capability, and throws otherwise. */
export function verifiedSpaceInviteLink(origin: string, slug: string, inviteLink: string): string {
  const value = inviteLink.trim();
  if (!value) throw new Error("The Space invite link was empty.");

  let url: URL;
  try {
    url = new URL(value, origin);
  } catch {
    throw new Error("The Space invite link was invalid.");
  }
  if (url.origin !== new URL(origin).origin) throw new Error("The Space invite link used an unexpected origin.");
  const code = inviteCodeByShape(url.pathname.slice(1));
  if (code && url.pathname === `/${code}` && !url.search && !url.hash) return value;
  if (url.pathname !== `/space/${encodeURIComponent(slug)}`) throw new Error("The Space invite link did not match the verified Space.");

  if (!readSpaceInviteToken(url.hash)?.startsWith("cspi1.")) throw new Error("The Space invite link did not contain a valid capability.");
  return value;
}

type InvitePath = { readonly segments: readonly string[]; readonly search: string; readonly hash: string };

/** The path of a link to a Chalk host or app protocol, or null for anything else. A bare `host/path` counts as https. */
function invitePath(input: string, hosts: readonly string[]): InvitePath | null {
  const trimmed = input.trim();
  const absolute = trimmed.includes("://") ? trimmed : hosts.some((host) => trimmed.startsWith(`${host}/`)) ? `https://${trimmed}` : null;
  if (!absolute) return null;
  try {
    const parsed = new URL(absolute);
    const isApp = APP_PROTOCOLS.has(parsed.protocol);
    if (!isApp && !isChalkWebOrigin(parsed, hosts)) return null;
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (isApp) segments.unshift(parsed.hostname);
    return { segments, search: parsed.search, hash: parsed.hash };
  } catch {
    return null;
  }
}

function isChalkWebOrigin(url: URL, hosts: readonly string[]): boolean {
  if (url.protocol === "https:") return hosts.includes(url.hostname);
  return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
}
