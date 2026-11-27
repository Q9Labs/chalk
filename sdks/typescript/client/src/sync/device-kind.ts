import type { PresenceProjectionItemSchema } from "../generated/sync";

/** The device a participant is on, as that device declared it. Computers carry their operating system. */
export type ParticipantDeviceKind = NonNullable<(typeof PresenceProjectionItemSchema.Type)["device_kind"]>;

/** The browser facts `detectWebDeviceKind` reads, so a test can pass a real browser's values. */
export type WebDeviceEnvironment = {
  readonly userAgent: string;
  /** `navigator.maxTouchPoints`: iPadOS Safari sends a Mac user agent, and only its touch screen tells it apart. */
  readonly maxTouchPoints?: number;
  /** `navigator.userAgentData` low-entropy values, present on Chromium browsers. */
  readonly userAgentData?: { readonly platform?: string; readonly mobile?: boolean };
};

// Samsung Galaxy Z Fold and Flip models (SM-F9xx, SM-F7xx) and the Pixel Fold. Chrome's reduced user agent hides the model,
// so this only recognises a foldable whose browser still sends it, such as Samsung Internet; the rest report phone or tablet.
const FOLDABLE_MODEL = /\bSM-F\d{3}|\bPixel Fold\b/u;

type Family = "ios" | "ipad" | "android" | "chromeos" | "mac" | "windows" | "linux";

// Checked in order: the first family whose user agent pattern or declared platform matches wins.
const FAMILIES: readonly { readonly family: Family; readonly agent: RegExp; readonly platforms: readonly string[] }[] = [
  { family: "ios", agent: /iPhone|iPod/u, platforms: ["iOS"] },
  { family: "ipad", agent: /iPad/u, platforms: [] },
  { family: "android", agent: /Android/u, platforms: ["Android"] },
  { family: "chromeos", agent: /CrOS/u, platforms: ["Chrome OS", "Chromium OS"] },
  { family: "mac", agent: /Macintosh|Mac OS X/u, platforms: ["macOS"] },
  { family: "windows", agent: /Windows/u, platforms: ["Windows"] },
  { family: "linux", agent: /Linux|X11/u, platforms: ["Linux"] },
];

/** What this browser says it runs on, or undefined when it says nothing recognisable. */
export function detectWebDeviceKind(environment: WebDeviceEnvironment): ParticipantDeviceKind | undefined {
  const { userAgent: agent, maxTouchPoints = 0, userAgentData } = environment;
  const platform = userAgentData?.platform ?? "";
  const family = FAMILIES.find((entry) => entry.agent.test(agent) || entry.platforms.includes(platform))?.family;
  if (family === "ios") return /iPad/u.test(agent) ? "ipad" : "iphone";
  if (family === "android") return androidKind(agent, userAgentData?.mobile);
  if (family === "mac") return maxTouchPoints > 1 ? "ipad" : "mac";
  return family;
}

function androidKind(agent: string, mobile: boolean | undefined): ParticipantDeviceKind {
  if (FOLDABLE_MODEL.test(agent)) return "android_foldable";
  // Android browsers add "Mobile" to a phone's user agent and leave it out of a tablet's.
  return (mobile ?? /Mobile/u.test(agent)) ? "android_phone" : "android_tablet";
}

/** The kind of the browser this code runs in; undefined outside a browser. */
export function browserDeviceKind(): ParticipantDeviceKind | undefined {
  if (typeof navigator === "undefined") return undefined;
  const { userAgent, maxTouchPoints, userAgentData } = navigator as Navigator & { readonly userAgentData?: WebDeviceEnvironment["userAgentData"] };
  return detectWebDeviceKind({ userAgent, maxTouchPoints, userAgentData });
}
