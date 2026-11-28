import { MediaGlyph, ShellIcon } from "../control-bar/ShellIcon";
import { BROWSER_MARKS } from "./browser-marks";
import { APP_NAMES, BROWSER_NAMES, DEVICE_NAMES } from "./card-copy";
import { type BrowserName, type DeviceAccessReason, type DeviceKind } from "./model";

const GLYPHS = {
  close: <path d="M6 6l12 12M18 6L6 18" />,
  tune: (
    <>
      <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
      <circle cx="15" cy="7" r="2" />
      <circle cx="9" cy="17" r="2" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </>
  ),
  updown: <path d="M8 10l4-4 4 4M8 14l4 4 4-4" />,
} as const;

export function Glyph({ name }: { readonly name: keyof typeof GLYPHS }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {GLYPHS[name]}
    </svg>
  );
}

export function DeviceGlyph({ device, off = false }: { readonly device: DeviceKind; readonly off?: boolean }) {
  if (device === "screen") return <ShellIcon name={off ? "shareOff" : "share"} />;
  return <MediaGlyph kind={device === "microphone" ? "mic" : "cam"} slashed={off} busy={false} />;
}

const Step = ({ n }: { readonly n: number }) => (
  <span className="chalk-access-step" aria-hidden="true">
    {n}
  </span>
);

/** The first mark exists for Chrome, Safari and Firefox. Edge and the other Chromium browsers show Chrome's steps without a mark. */
function markOf(browser: BrowserName): string | null {
  return browser === "edge" ? null : BROWSER_MARKS[browser];
}

const Host = () => location.host;

function BrowserSteps({ device, browser }: { readonly device: Exclude<DeviceKind, "screen">; readonly browser: BrowserName }) {
  const name = DEVICE_NAMES[device];
  const host = Host();
  if (browser === "safari")
    return (
      <div className="chalk-access-ill">
        <div className="chalk-access-menubar">
          <b>Safari</b>
          <span>File</span>
          <span>Edit</span>
          <span>View</span>
          <Step n={1} />
        </div>
        <div className="chalk-access-menu" data-flush>
          <div className="chalk-access-row" data-hit>
            <span className="grow">Settings for {host}…</span>
            <Step n={2} />
          </div>
          <div className="chalk-access-row">
            <DeviceGlyph device={device} />
            <span className="grow">{name}</span>
            <span className="value">
              Allow <Glyph name="updown" />
            </span>
            <Step n={3} />
          </div>
        </div>
        <ol className="sr-only">
          <li>Open the Safari menu.</li>
          <li>Choose Settings for {host}.</li>
          <li>Set {name} to Allow.</li>
        </ol>
      </div>
    );
  if (browser === "firefox")
    return (
      <div className="chalk-access-ill">
        <div className="chalk-access-bar">
          <span className="icon">
            <Glyph name="lock" />
          </span>
          <span className="icon" data-hit data-off>
            <DeviceGlyph device={device} off />
          </span>
          <span className="grow">{host}</span>
          <Step n={1} />
        </div>
        <div className="chalk-access-menu">
          <div className="chalk-access-row" data-hit>
            <span className="grow">{name}</span>
            <span className="value">Blocked</span>
            <Glyph name="close" />
            <Step n={2} />
          </div>
        </div>
        <ol className="sr-only">
          <li>Select the blocked {name.toLowerCase()} icon in the address bar.</li>
          <li>Remove the Blocked setting for {name}.</li>
        </ol>
      </div>
    );
  return (
    <div className="chalk-access-ill">
      <div className="chalk-access-bar">
        <span className="icon" data-hit>
          <Glyph name="tune" />
        </span>
        <span className="grow">{host}</span>
        <Step n={1} />
      </div>
      <div className="chalk-access-menu">
        <div className="chalk-access-row" data-hit>
          <DeviceGlyph device={device} />
          <span className="grow">{name}</span>
          <span className="chalk-access-switch" />
          <Step n={2} />
        </div>
      </div>
      <ol className="sr-only">
        <li>Select the site settings icon next to the address.</li>
        <li>Turn on {name}.</li>
      </ol>
    </div>
  );
}

function IosSafariSteps({ device }: { readonly device: Exclude<DeviceKind, "screen"> }) {
  const name = DEVICE_NAMES[device];
  const host = Host();
  return (
    <div className="chalk-access-ill">
      <div className="chalk-access-bar">
        <span className="icon" data-hit>
          aA
        </span>
        <span className="grow">{host}</span>
        <Step n={1} />
      </div>
      <div className="chalk-access-menu">
        <div className="chalk-access-row" data-hit>
          <span className="grow">Website Settings</span>
          <Step n={2} />
        </div>
        <div className="chalk-access-row">
          <DeviceGlyph device={device} />
          <span className="grow">{name}</span>
          <span className="value">
            Allow <Glyph name="updown" />
          </span>
          <Step n={3} />
        </div>
      </div>
      <ol className="sr-only">
        <li>Tap aA in the address bar.</li>
        <li>Tap Website Settings.</li>
        <li>Set {name} to Allow.</li>
      </ol>
    </div>
  );
}

function AndroidSiteSteps({ device }: { readonly device: Exclude<DeviceKind, "screen"> }) {
  const name = DEVICE_NAMES[device];
  return (
    <div className="chalk-access-ill">
      <div className="chalk-access-bar">
        <span className="icon" data-hit>
          <Glyph name="tune" />
        </span>
        <span className="grow">{Host()}</span>
        <Step n={1} />
      </div>
      <div className="chalk-access-menu">
        <div className="chalk-access-row" data-hit>
          <span className="grow">Permissions</span>
          <Step n={2} />
        </div>
        <div className="chalk-access-row">
          <DeviceGlyph device={device} />
          <span className="grow">{name}</span>
          <span className="chalk-access-switch" />
          <Step n={3} />
        </div>
      </div>
      <ol className="sr-only">
        <li>Tap the site settings icon next to the address.</li>
        <li>Tap Permissions.</li>
        <li>Turn on {name}.</li>
      </ol>
    </div>
  );
}

/** One path, one switch: the iPhone Settings page of the browser app, the Android app permission, or a desktop privacy pane. */
function PathSteps({ device, path, value, children }: { readonly device: DeviceKind; readonly path: string; readonly value: "switch" | "Allow"; readonly children: string }) {
  return (
    <div className="chalk-access-ill">
      <div className="chalk-access-menu" data-flush>
        <span className="chalk-access-path">{path}</span>
        <div className="chalk-access-row" data-hit>
          <DeviceGlyph device={device} />
          <span className="grow">{DEVICE_NAMES[device]}</span>
          {value === "switch" ? <span className="chalk-access-switch" /> : <span className="value">Allow</span>}
          <Step n={1} />
        </div>
      </div>
      <p className="sr-only">{children}</p>
    </div>
  );
}

function SystemSteps({ device, reason }: { readonly device: DeviceKind; readonly reason: Extract<DeviceAccessReason, { kind: "blocked-system" }> }) {
  const pane = device === "microphone" ? "Microphone" : device === "camera" ? "Camera" : "Screen & System Audio Recording";
  const browser = reason.browser;
  const mark = markOf(browser);
  if (reason.platform === "android")
    return (
      <PathSteps device={device} path={"Settings › Apps › " + BROWSER_NAMES[browser] + " › Permissions"} value="Allow">
        {"Allow " + DEVICE_NAMES[device] + " in the app's permissions."}
      </PathSteps>
    );
  const mac = reason.platform === "mac";
  return (
    <div className="chalk-access-ill">
      <div className="chalk-access-menu" data-flush>
        <span className="chalk-access-path">{mac ? "System Settings › Privacy & Security › " + pane : "Settings › Privacy & security › " + pane}</span>
        <div className="chalk-access-row" data-hit>
          {mac && mark ? <img alt="" src={mark} /> : null}
          <span className="grow">{mac ? APP_NAMES[browser] : "Let desktop apps access your " + DEVICE_NAMES[device].toLowerCase()}</span>
          <span className="chalk-access-switch" />
          <Step n={1} />
        </div>
      </div>
      <p className="sr-only">{mac ? "Turn on " + APP_NAMES[browser] + " under " + pane + "." : "Turn on " + pane + "."}</p>
    </div>
  );
}

function ListSteps({ path, row, value, hit = true, second }: { readonly path: string; readonly row: string; readonly value?: string; readonly hit?: boolean; readonly second?: { readonly label: string; readonly value: string } }) {
  return (
    <div className="chalk-access-ill">
      <div className="chalk-access-menu" data-flush>
        <span className="chalk-access-path">{path}</span>
        <div className="chalk-access-row" data-hit={hit || undefined}>
          <span className="grow">{row}</span>
          {value ? <span className="value">{value}</span> : null}
          <Step n={1} />
        </div>
        {second ? (
          <div className="chalk-access-row">
            <span className="grow">{second.label}</span>
            <span className="value">{second.value}</span>
            <Step n={2} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function Illustration({ device, reason, defaultDeviceLabel }: { readonly device: DeviceKind; readonly reason: DeviceAccessReason; readonly defaultDeviceLabel?: string }) {
  const lower = DEVICE_NAMES[device].toLowerCase();
  const media = device === "screen" ? null : device;
  switch (reason.kind) {
    case "blocked-browser":
      if (!media) return null;
      if (reason.platform === "ios") return <IosSafariSteps device={media} />;
      if (reason.platform === "android") return <AndroidSiteSteps device={media} />;
      return <BrowserSteps device={media} browser={reason.browser} />;
    case "blocked-app": {
      const app = BROWSER_NAMES[reason.browser];
      return (
        <PathSteps device={device} path={"Settings › " + app} value="switch">
          {"Open Settings, tap " + app + " and turn on " + DEVICE_NAMES[device] + "."}
        </PathSteps>
      );
    }
    case "blocked-system":
      return <SystemSteps device={device} reason={reason} />;
    case "busy":
      return reason.platform === "ios" || reason.platform === "android" ? null : <ListSteps path="Apps that may be using it" row="Teams, Zoom, Camera, a video call" value="Close" hit={false} />;
    case "unavailable":
      return <ListSteps path={device === "microphone" ? "Microphones Chalk can see" : "Cameras Chalk can see"} row={defaultDeviceLabel ?? "Default " + lower} value="Default" />;
    case "screen-declined":
      return <ListSteps path="Choose what to share" row="Entire screen · Window · Tab" second={{ label: "Share", value: "press to start" }} />;
    case "missing":
      return null;
  }
}
