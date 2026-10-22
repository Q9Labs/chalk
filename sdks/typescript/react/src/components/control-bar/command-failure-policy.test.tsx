// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { SpaceClientError, type ErrorCode } from "@q9labsai/chalk-client";
import { commandFailurePresentation, MEDIA_FAILURE_POLICY, type MediaCommandAction, type MediaCommandSource } from "./command-failure";
import { ChalkProvider } from "../../bindings/context";
import { createPreviewClient, createSnapshot } from "../../test-support/preview-client";
import { Chalk } from "../chalk/Chalk";
import { SpaceView } from "../space-view/SpaceView";

type Family = "access" | "generic" | "interrupted" | "unsupported" | "ended" | "permission" | "missing" | "busy" | "constraint" | "capture" | "invalid";
const row = (code: ErrorCode, family: Family, retry: boolean) => ({ code, family, retry });
// Independent expected policy: adding a client code requires an explicit expectation here.
const CASES = {
  "access.invalid": row("access.invalid", "access", false),
  "access.unavailable": row("access.unavailable", "access", false),
  "chat.cursor_reset_required": row("chat.cursor_reset_required", "generic", false),
  "chat.payload_invalid": row("chat.payload_invalid", "generic", false),
  "client.internal_error": row("client.internal_error", "generic", true),
  "collaboration.unavailable": row("collaboration.unavailable", "generic", false),
  "command.rate_limited": row("command.rate_limited", "generic", true),
  "command.rejected": row("command.rejected", "generic", false),
  "connection.invalid_state": row("connection.invalid_state", "interrupted", true),
  "connection.join_cleanup_unconfirmed": row("connection.join_cleanup_unconfirmed", "generic", false),
  "connection.leave_unconfirmed": row("connection.leave_unconfirmed", "generic", false),
  "connection.media_recovery_exhausted": row("connection.media_recovery_exhausted", "generic", false),
  "connection.media_start_failed": row("connection.media_start_failed", "generic", true),
  "connection.state_digest_recovery_failed": row("connection.state_digest_recovery_failed", "generic", false),
  "connection.sync_recovery_exhausted": row("connection.sync_recovery_exhausted", "generic", false),
  "connection.sync_start_failed": row("connection.sync_start_failed", "generic", false),
  "connection.sync_hello_timeout": row("connection.sync_hello_timeout", "generic", false),
  "environment.unsupported": row("environment.unsupported", "unsupported", false),
  "episode.ended": row("episode.ended", "ended", false),
  "media.permission_denied": row("media.permission_denied", "permission", false),
  "media.device_not_found": row("media.device_not_found", "missing", false),
  "media.device_busy": row("media.device_busy", "busy", true),
  "media.device_constraint_invalid": row("media.device_constraint_invalid", "constraint", false),
  "media.capture_failed": row("media.capture_failed", "capture", true),
  "media.request_invalid": row("media.request_invalid", "invalid", false),
  "media.timeout": row("media.timeout", "generic", true),
  "offline.discarded": row("offline.discarded", "generic", false),
  "participant.invalid": row("participant.invalid", "generic", false),
  "reaction.invalid": row("reaction.invalid", "generic", false),
  "whiteboard.unavailable": row("whiteboard.unavailable", "generic", false),
} satisfies Record<ErrorCode, ReturnType<typeof row>>;
const operations = ["start", "stop", "select", "test", "request", undefined] as const;
const sources = ["camera", "microphone", "screen", "speaker", undefined] as const;
const playback = "Couldn’t play the speaker test. Check your browser’s audio settings and system volume.";
const unsupported = "Media capture is unavailable in this environment. Use a supported browser over HTTPS or the native app.";
function expectedMessage(family: Family, source: MediaCommandSource | undefined, operation: MediaCommandAction | undefined, recoverable: boolean): string {
  const device = source ?? "device";
  const again = recoverable ? " Try again." : "";
  const then = recoverable ? ", then try again" : "";
  const settings = `Couldn’t change ${source === "screen" ? "screen sharing" : `your ${device} settings`}.`;
  const generic =
    operation === "start"
      ? source === "screen"
        ? "Your screen couldn’t be shared."
        : `Your ${device} couldn’t start.`
      : operation === "stop" && source === "screen"
        ? "Couldn’t stop screen sharing."
        : operation === "select"
          ? `Couldn’t select your ${device}.`
          : operation === "test"
            ? playback
            : operation === "request"
              ? `Couldn’t respond to the ${device} request.`
              : settings;
  if (family === "ended") return "This call has ended.";
  if (family === "invalid") return operation === "request" ? "The media request is no longer active." : operation === "select" ? `Choose a valid ${device} from the device list.` : operation === "test" ? "The speaker test is no longer available." : "This media action is no longer available.";
  if (family === "unsupported")
    return operation === "stop"
      ? generic + again
      : operation === "test"
        ? "This browser can’t play a speaker test. Check your browser’s audio settings or use another supported browser."
        : source === "speaker" && operation !== "start" && operation !== "request"
          ? "This browser can’t change your speaker. Use your system sound settings to choose an output device."
          : unsupported;
  if (family === "interrupted" && operation !== "request" && operation !== "test") return "That change was interrupted." + again;
  if (operation === "test" || operation === "stop") return generic + again;
  if (family === "access") return "Your call access is unavailable. Rejoin the call.";
  if (family === "permission")
    return source === "screen"
      ? `Your screen couldn’t be shared. Allow screen recording for your browser in System Settings${then}.`
      : source === "speaker"
        ? "Chalk can’t use your speaker. Check your browser’s audio permissions and system sound settings."
        : `Chalk can’t use your ${device}. Click the camera icon in the address bar and allow ${source === "camera" ? "Camera" : source === "microphone" ? "Microphone" : "Camera and Microphone"}.`;
  if (family === "missing") return `No ${device} found. Plug one in, or check that your Mac can see it in System Settings.`;
  if (family === "busy") return `Your ${device} is being used by another app. Close it there${then}.`;
  if (family === "constraint") return `Your ${device} doesn’t support these settings. Choose another ${device}${then}.`;
  if (family === "capture" && (operation === "start" || operation === "request")) return source === "screen" ? "Your screen couldn’t be shared." + again : `Your ${device} couldn’t start. Check that it is connected and available${then}.`;
  if (family === "capture" && operation === undefined) return source === "screen" ? settings + again : `${settings} Check that it is connected and available${then}.`;
  return generic + again;
}

beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(() => vi.unstubAllGlobals());

it("walks every client-code / operation / source / recoverability / retained-command row through the real formatter", () => {
  expect(
    Object.values(CASES)
      .map((entry) => entry.code)
      .sort(),
  ).toEqual(Object.keys(MEDIA_FAILURE_POLICY).sort());
  let rows = 0;
  for (const { code, family, retry } of Object.values(CASES))
    for (const operation of operations)
      for (const source of sources)
        for (const recoverable of [false, true])
          for (const hasExactRetry of [false, true]) {
            const failure = { code, recoverable, message: "Private implementation details" };
            const rawNonMedia = source === undefined && operation === undefined && !code.startsWith("media.");
            expect(commandFailurePresentation(failure, source, operation, hasExactRetry), `${code}/${operation}/${source}/${recoverable}/${hasExactRetry}`).toEqual({
              message: rawNonMedia ? failure.message : expectedMessage(family, source, operation, recoverable),
              retry: !rawNonMedia && retry && recoverable && hasExactRetry && source !== undefined && source !== "speaker" && (operation === "start" || operation === "stop"),
            });
            rows++;
          }
  expect(rows).toBe(3600);
});

it("walks every actionable policy row through SpaceView and replays the exact failed start/stop command", async () => {
  let rows = 0;
  for (const { code, family, retry } of Object.values(CASES)) {
    if (!retry) continue;
    for (const source of ["camera", "microphone", "screen"] as const)
      for (const operation of ["start", "stop"] as const) {
        const snapshot = createSnapshot(["publishAudio", "publishVideo", "publishScreen"]);
        const preview = createPreviewClient({ ...snapshot, connection: { ...snapshot.connection, status: "live" } });
        if (operation === "stop") {
          await preview.media.setCameraEnabled(true);
          await preview.media.setMicrophoneEnabled(true);
          await preview.media.setScreenShareEnabled(true);
        }
        const command = vi.fn(async (_enabled: boolean) => {
          throw new SpaceClientError({ code, recoverable: true, message: "Private implementation details" });
        });
        const client = { ...preview, media: { ...preview.media, setCameraEnabled: command, setMicrophoneEnabled: command, setScreenShareEnabled: command } };
        const container = document.body.appendChild(document.createElement("div"));
        const root = createRoot(container);
        try {
          await act(async () =>
            root.render(
              <ChalkProvider client={client}>
                <SpaceView features={{ sounds: false }} generatedAvatars={false} />
              </ChalkProvider>,
            ),
          );
          const part = source === "camera" ? "video" : source === "microphone" ? "mic" : "share";
          const button = container.querySelector<HTMLButtonElement>(`[data-part="${part}-split"] .chalk-shell-main`);
          expect(button, `${code}/${source}/${operation}`).toBeDefined();
          await act(async () => button?.click());
          expect(container.textContent).toContain(expectedMessage(family, source, operation, true));
          const retryButton = Array.from(container.querySelectorAll("button")).find((item) => item.textContent === "Try again");
          expect(retryButton, `${code}/${source}/${operation}`).toBeDefined();
          await act(async () => retryButton?.click());
          expect(command).toHaveBeenCalledTimes(2);
          expect(command.mock.calls[0]?.[0]).toBe(operation === "start");
          expect(command.mock.calls[1]).toEqual(command.mock.calls[0]);
          expect(container.textContent).toContain(expectedMessage(family, source, operation, true));
          rows++;
        } finally {
          await act(async () => root.unmount());
          container.remove();
          preview.dispose();
        }
      }
  }
  expect(rows).toBe(42);
});

it("uses safe terminal copy for unknown runtime codes in every media context", () => {
  for (const code of ["media.new_capture_failure", "future.failure", "__proto__", "toString"])
    for (const source of sources)
      for (const operation of operations)
        for (const recoverable of [false, true]) {
          const failure = { code: "client.internal_error", recoverable, message: "setCameraEnabled belongs to private internals" } satisfies import("@q9labsai/chalk-client").ClientFailure;
          // Simulate a newer dependency/server value crossing the older package's typed boundary.
          Reflect.set(failure, "code", code);
          expect(commandFailurePresentation(failure, source, operation, true)).toEqual({ message: "This media action couldn’t be completed.", retry: false });
        }
});

it.each([
  { source: "camera", action: "Allow" },
  { source: "camera", action: "Not now" },
  { source: "microphone", action: "Allow" },
  { source: "microphone", action: "Not now" },
] as const)("walks integrated Chalk request rows for $source / $action", async ({ source, action }) => {
  const snapshot = createSnapshot(["publishAudio", "publishVideo"]);
  const preview = createPreviewClient({ ...snapshot, connection: { ...snapshot.connection, status: "live" } });
  let failure = new SpaceClientError({ code: "client.internal_error", recoverable: false, message: "Private implementation details" });
  const command = vi.fn(async (_requestId: string) => {
    throw failure;
  });
  const client = { ...preview, media: { ...preview.media, acceptRequest: command, declineRequest: command } };
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  let rows = 0;
  try {
    await act(async () => root.render(<Chalk client={client} features={{ sounds: false, whiteboard: false }} />));
    for (const { code, family } of Object.values(CASES))
      for (const recoverable of [false, true]) {
        failure = new SpaceClientError({ code, recoverable, message: "Private implementation details" });
        const request = { requestId: `policy-request-${rows}`, kind: source === "camera" ? "start_camera" : "unmute", actorParticipantId: "requester", actorDisplayName: "Requester", expiresAt: new Date(Date.now() + 60_000).toISOString() } as const;
        await act(async () => preview.updateSnapshot((current) => ({ ...current, media: { ...current.media, incomingRequests: [request] } })));
        const button = Array.from(container.querySelectorAll("button")).find((item) => item.textContent === action);
        expect(button, `${code}/${source}/${action}`).toBeDefined();
        await act(async () => button?.click());
        expect(command).toHaveBeenLastCalledWith(request.requestId);
        expect(command).toHaveBeenCalledTimes(rows + 1);
        expect(container.textContent, `${code}/${source}/${action}/${recoverable}`).toContain(expectedMessage(family, source, "request", recoverable));
        expect(container.textContent).not.toContain("Private implementation details");
        expect(Array.from(container.querySelectorAll("button")).some((item) => item.textContent === "Try again")).toBe(false);
        rows++;
      }
    expect(rows).toBe(60);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    preview.dispose();
  }
});
