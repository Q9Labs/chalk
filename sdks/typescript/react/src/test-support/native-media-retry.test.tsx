// @vitest-environment happy-dom
import { act, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { SpaceClientError } from "@q9labsai/chalk-client";
import { liveMediaClient } from "./live-media.test.helpers";
import { useSpaceClient } from "../../../react-native/src/context/space-client-context";
import { useToasts } from "../../../react-native/src/primitives/toast/ToastStack";
import { createToastStore } from "../../../react-native/src/primitives/toast/toast-store";
import { useCallEventToasts, type Permission } from "../../../react-native/src/toasts/CallEventToasts";

vi.mock("../../../react-native/node_modules/react-native", () => ({ Linking: {}, Platform: { OS: "ios" } }));
vi.mock("../../../react-native/src/context/space-client-context", () => ({ useSpaceClient: vi.fn() }));
vi.mock("../../../react-native/src/primitives/toast/ToastStack", () => ({ useToasts: vi.fn() }));
vi.mock("../../../react-native/src/primitives/announce", () => ({ announce: () => {} }));
vi.mock("../../../react-native/src/avatar/FaceAvatar", () => ({ FaceAvatar: () => null }));
vi.mock("../../../react-native/src/icons/Icon", () => ({ Icon: () => null }));
vi.mock("../../../react-native/src/frame/preferences", () => ({ usePreferences: () => ({ soundsEnabled: false }) }));
vi.mock("../../../react-native/src/theme/theme", () => ({ useTheme: () => ({ colors: {} }) }));
vi.mock("../../../react-native/src/theme/tokens", () => ({ durations: { toastInfo: 5000 } }));
vi.mock("../../../react-native/src/sounds/sounds", () => ({ playSound: () => {} }));

it.each(["camera", "microphone"] as const)("checks the current connection before retrying native %s", async (permission) => {
  const fixture = await liveMediaClient();
  const { client, capture } = fixture;
  const store = createToastStore();
  vi.mocked(useSpaceClient).mockReturnValue(client);
  vi.mocked(useToasts).mockReturnValue(store);
  const retry = permission === "microphone" ? () => client.media.setMicrophoneEnabled(true) : () => client.media.setCameraEnabled(true);
  // Render the native hook and real toast store; only native host boundaries are stubbed.
  function Harness({ permission }: { permission: Permission }) {
    const events = useCallEventToasts({});
    const toasts = useSyncExternalStore(store.subscribe, store.getSnapshot);
    return (
      <>
        <button onClick={() => events.reportMediaFailure(permission, new SpaceClientError({ code: "media.device_busy", recoverable: true, message: "Device busy" }), retry)}>Report busy</button>
        {toasts.flatMap(
          (toast) =>
            toast.actions?.map((action) => (
              <button key={toast.id} onClick={action.onPress}>
                {action.label}
              </button>
            )) ?? [],
        )}
      </>
    );
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Harness permission={permission} />));
    await act(async () => container.querySelector("button")?.click());
    const action = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Try again");
    if (!action) throw new Error("Missing native media retry");
    await act(async () => fixture.health(true));
    await act(async () => action.click());
    await expect(fixture.actions[permission].mock.results.at(-1)?.value).rejects.toMatchObject({ code: "connection.invalid_state" });
    expect(capture).not.toHaveBeenCalled();
    expect(store.getSnapshot()).toHaveLength(1);
    await act(async () => fixture.health(false));
    await act(async () => action.click());
    await act(async () =>
      vi.waitFor(() => {
        expect(capture).toHaveBeenCalledTimes(1);
        expect(store.getSnapshot()).toHaveLength(0);
      }),
    );
  } finally {
    await act(async () => root.unmount());
    store.clear();
    container.remove();
    client.dispose();
    vi.restoreAllMocks();
  }
});

it.each(["unmute", "start_camera"] as const)("checks the current connection before accepting native %s requests", async (kind) => {
  const fixture = await liveMediaClient();
  const { client, capture } = fixture;
  const store = createToastStore();
  vi.mocked(useSpaceClient).mockReturnValue(client);
  vi.mocked(useToasts).mockReturnValue(store);
  function Harness() {
    useCallEventToasts({});
    const toasts = useSyncExternalStore(store.subscribe, store.getSnapshot);
    return (
      <>
        {toasts.flatMap(
          (toast) =>
            toast.actions?.map((action) => (
              <button key={toast.id} onClick={action.onPress}>
                {action.label}
              </button>
            )) ?? [],
        )}
      </>
    );
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Harness />));
    await act(async () => fixture.request(kind));
    const action = container.querySelector("button");
    if (!action) throw new Error("Missing native request acceptance");
    await act(async () => fixture.health(true));
    await act(async () => action.click());
    await expect(fixture.actions.request.mock.results.at(-1)?.value).rejects.toMatchObject({ code: "connection.invalid_state" });
    expect(capture).not.toHaveBeenCalled();
    expect(store.getSnapshot()).toHaveLength(1);
    await act(async () => fixture.health(false));
    await act(async () => action.click());
    await act(async () =>
      vi.waitFor(() => {
        expect(capture).toHaveBeenCalledOnce();
        expect(store.getSnapshot()).toHaveLength(0);
      }),
    );
  } finally {
    await act(async () => root.unmount());
    store.clear();
    container.remove();
    client.dispose();
    vi.restoreAllMocks();
  }
});
