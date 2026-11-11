import { SpaceClientError } from "@q9labsai/chalk-client";
import { Chalk } from "@q9labsai/chalk-react";
import { useEffect, useState } from "react";
import { createCallStateClient, PEOPLE, liveSnapshot } from "./fixtures";
import type { CallState } from "./states";

type Device = "microphone" | "camera" | "screen";
type Moment = "waiting" | "browser" | "system" | "busy" | "missing" | "closed";

const AGENTS = {
  chrome: { mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36", windows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36" },
  safari: { mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15", windows: "" },
  firefox: { mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.7; rv:132.0) Gecko/20100101 Firefox/132.0", windows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0" },
} as const;

function define(target: object, name: string, value: unknown) {
  Object.defineProperty(target, name, { configurable: true, get: () => value });
}

/** Fakes what the browser reports, so each moment of the access card can be shown without a real refusal. */
function pretendBrowser({ browser, platform, permission, askable }: { browser: keyof typeof AGENTS; platform: "mac" | "windows"; permission: string; askable: boolean }) {
  define(navigator, "userAgent", AGENTS[browser][platform] || AGENTS[browser].mac);
  if (!askable) return define(navigator, "permissions", undefined);
  define(navigator, "permissions", { query: async () => Object.assign(new EventTarget(), { state: permission }) });
  if (typeof navigator.mediaDevices?.getDisplayMedia !== "function") navigator.mediaDevices.getDisplayMedia = async () => new MediaStream();
}

function DeviceAccessCall({ device, moment, browser, platform, colorScheme }: { device: Device; moment: Moment; browser: keyof typeof AGENTS; platform: "mac" | "windows"; colorScheme: "dark" | "light" }) {
  const [client] = useState(() => {
    pretendBrowser({ browser, platform, askable: browser !== "safari", permission: moment === "waiting" ? "prompt" : moment === "system" ? "granted" : "denied" });
    const instance = createCallStateClient(liveSnapshot({ self: { microphone: false, camera: false }, others: PEOPLE.slice(0, 3) }));
    const fail = async (source: Device) => {
      if (moment === "waiting") {
        instance.updateSnapshot((current) => ({ ...current, media: { ...current.media, local: { ...current.media.local, [source]: { ...current.media.local[source], state: "requesting" } } } }));
        return new Promise<never>(() => {});
      }
      const code = moment === "busy" ? "media.device_busy" : moment === "missing" ? "media.device_not_found" : "media.permission_denied";
      throw new SpaceClientError({ code, recoverable: true, message: code, ...(moment === "system" ? { permissionBlock: "system" as const } : {}) });
    };
    return { ...instance, media: { ...instance.media, setMicrophoneEnabled: () => fail("microphone"), setCameraEnabled: () => fail("camera"), setScreenShareEnabled: () => fail("screen") } };
  });
  useEffect(() => {
    const timer = setTimeout(() => {
      const part = device === "microphone" ? "mic-split" : device === "camera" ? "video-split" : "share-split";
      const main = document.querySelector<HTMLElement>(`[data-part="${part}"] .chalk-shell-main`);
      main?.click();
      if (moment === "closed") {
        setTimeout(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })), 400);
        setTimeout(() => document.querySelector("[data-part=call-frame]")?.dispatchEvent(new PointerEvent("pointermove", { bubbles: true })), 4500);
      }
    }, 600);
    return () => clearTimeout(timer);
  }, [device, moment]);
  return (
    <main className="h-dvh min-h-0 w-full overflow-hidden">
      <Chalk theme={{ colorScheme }} client={client} spaceName="Team call" shareUrl="https://chalkmeet.com/team-call" />
    </main>
  );
}

function fromQuery(): { device: Device; moment: Moment; browser: keyof typeof AGENTS; platform: "mac" | "windows"; colorScheme: "dark" | "light" } {
  const params = new URLSearchParams(location.search);
  const pick = <T extends string>(name: string, allowed: readonly T[], fallback: T): T => allowed.find((value) => value === params.get(name)) ?? fallback;
  return {
    device: pick("device", ["microphone", "camera", "screen"], "microphone"),
    moment: pick("moment", ["waiting", "browser", "system", "busy", "missing", "closed"], "browser"),
    browser: pick("browser", ["chrome", "safari", "firefox"], "chrome"),
    platform: pick("platform", ["mac", "windows"], "mac"),
    colorScheme: pick("theme", ["dark", "light"], "dark"),
  };
}

export const DEVICE_ACCESS_STATES: readonly CallState[] = [{ id: "device-access", title: "Device access card (device, moment, browser, platform, theme in the query)", render: () => <DeviceAccessCall {...fromQuery()} /> }];
