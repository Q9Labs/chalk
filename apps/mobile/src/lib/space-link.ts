import { INVITE_HOSTS, parseChalkInviteLink } from "@q9labsai/chalk-client/invites";
import { getCustomTabsSupportingBrowsersAsync, openBrowserAsync } from "expo-web-browser";
import { Platform } from "react-native";
import { getApiBaseURL } from "./mobile-config";

const NIGHTLY_API = "https://nightly-api.chalkmeet.com";
const NIGHTLY_WEB_HOST = "nightly.chalkmeet.com";

export type SpaceRoute = {
  readonly kind: "space";
  readonly space: string;
  readonly spaceInviteToken: string;
  readonly inviteLink: string;
  readonly spaceName?: string;
  readonly source: "space-link" | "created-space";
};

/** The nightly build also reads links on the nightly web host. */
function inviteHosts(): readonly string[] {
  return getApiBaseURL() === NIGHTLY_API ? [...INVITE_HOSTS, NIGHTLY_WEB_HOST] : INVITE_HOSTS;
}

export function parseSpaceLink(input: string): SpaceRoute | null {
  const inviteLink = input.trim();
  const invite = parseChalkInviteLink(inviteLink, { hosts: inviteHosts() });
  if (!invite) return null;
  return {
    kind: "space",
    space: invite.slug ?? invite.spaceInviteToken,
    spaceInviteToken: invite.spaceInviteToken,
    inviteLink,
    source: "space-link",
  };
}

/** Returns the Space a link opens. Any other Chalk web link opens in the browser, and the result is null. */
export async function routeMobileLink(input: string | null): Promise<SpaceRoute | null> {
  if (!input) return null;
  const route = parseSpaceLink(input);
  if (route) return route;
  const url = parseUrl(input);
  if (url && isChalkWebLink(url)) await openInBrowser(url);
  return null;
}

function parseUrl(input: string): URL | undefined {
  try {
    return new URL(input);
  } catch {
    return undefined;
  }
}

function isChalkWebLink(url: URL): boolean {
  return (url.protocol === "https:" || url.protocol === "http:") && inviteHosts().includes(url.hostname);
}

async function openInBrowser(url: URL): Promise<void> {
  // Linking.openURL would send an associated URL straight back to this app.
  if (Platform.OS !== "android") {
    await openBrowserAsync(url.href);
    return;
  }
  const browsers = await getCustomTabsSupportingBrowsersAsync();
  const browserPackage = browsers.defaultBrowserPackage ?? browsers.preferredBrowserPackage ?? browsers.browserPackages[0];
  if (!browserPackage) throw new Error("No browser is available to open this Chalk link.");
  await openBrowserAsync(url.href, { browserPackage });
}

/** The link as people read it: host and path, without the scheme or the invite token. */
export function displayLink(inviteLink: string): string {
  return inviteLink.replace(/^[a-z][a-z0-9+.-]*:\/\//iu, "").replace(/[?#].*$/u, "");
}
