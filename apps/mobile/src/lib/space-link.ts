import { parseChalkInviteLink } from "@q9labsai/chalk-react-native/invites";
import { getCustomTabsSupportingBrowsersAsync, openBrowserAsync } from "expo-web-browser";
import { Platform } from "react-native";
import { getApiBaseURL } from "./mobile-config";

const NIGHTLY_API = "https://nightly-api.chalkmeet.com";
const NIGHTLY_WEB_HOST = "nightly.chalkmeet.com";
const CHALK_WEB_HOSTS = ["chalkmeet.com", "chalk.q9labs.ai"];

export type SpaceRoute = {
  readonly kind: "space";
  readonly space: string;
  readonly spaceInviteToken: string;
  readonly inviteLink: string;
  readonly spaceName?: string;
  readonly source: "space-link" | "created-space";
};

/** On the nightly build, a link on the nightly web host is read as the production link it mirrors. */
function productionLink(link: string): string {
  if (getApiBaseURL() !== NIGHTLY_API) return link;
  try {
    const url = new URL(link);
    if (url.protocol !== "https:" || url.hostname !== NIGHTLY_WEB_HOST || url.username || url.password || url.port) return link;
    url.hostname = "chalkmeet.com";
    return url.toString();
  } catch {
    // Invite codes are not URLs and remain valid inputs.
    return link;
  }
}

export function parseSpaceLink(input: string): SpaceRoute | null {
  const inviteLink = input.trim();
  const invite = parseChalkInviteLink(productionLink(inviteLink));
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
  const isNightlyHost = url.hostname === NIGHTLY_WEB_HOST && getApiBaseURL() === NIGHTLY_API;
  return (url.protocol === "https:" || url.protocol === "http:") && (CHALK_WEB_HOSTS.includes(url.hostname) || isNightlyHost);
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
