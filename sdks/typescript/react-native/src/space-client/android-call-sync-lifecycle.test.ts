import type { SpaceSnapshot } from "@q9labsai/chalk-client";
import { expect, it } from "vitest";
import { createAndroidCallSyncLifecycle } from "./android-call-sync-lifecycle";

function observeCall() {
  let notifyDevice: ((state: string) => void) | undefined;
  let notifyCall: (() => void) | undefined;
  let share: SpaceSnapshot["media"]["screenShare"]["state"] = "disabled";
  let status: SpaceSnapshot["connection"]["status"] = "live";
  const appState = {
    currentState: "active",
    addEventListener(_event: "change", listener: (state: string) => void) {
      notifyDevice = listener;
      return {
        remove: () => {
          notifyDevice = undefined;
        },
      };
    },
  };
  const client = {
    getSnapshot: () => ({ connection: { status }, media: { screenShare: { state: share } } }),
    subscribe(listener: () => void) {
      notifyCall = listener;
      return () => {
        notifyCall = undefined;
      };
    },
  };
  const events: string[] = [];
  const stop = createAndroidCallSyncLifecycle(appState, () => client).subscribe((event) => events.push(event));
  return {
    events,
    stop,
    device: (state: string) => notifyDevice?.(state),
    share: (state: typeof share) => {
      share = state;
      notifyCall?.();
    },
    connection: (next: typeof status) => {
      status = next;
      notifyCall?.();
    },
  };
}

it("keeps Sync connected through projection consent, a live share and app switches", () => {
  const call = observeCall();
  call.share("requesting");
  call.device("background"); // Android's projection picker is a different Activity.
  call.share("enabled");
  call.device("active");
  call.device("background"); // The user switches to the content they want to share.
  expect(call.events).toEqual(["active"]);

  call.share("disabled");
  expect(call.events).toEqual(["active", "inactive"]);
  call.device("active");
  expect(call.events).toEqual(["active", "inactive", "active"]);
});

it("still suspends Sync on a cancelled Android picker or a background call without a share", () => {
  const call = observeCall();
  call.share("requesting");
  call.device("background");
  call.share("failed");
  call.device("active");
  call.device("background");
  expect(call.events).toEqual(["active", "inactive", "active", "inactive"]);
});

it("does not hold Sync open after leaving and detaches both subscriptions", () => {
  const call = observeCall();
  call.share("enabled");
  call.device("background");
  call.connection("leaving");
  call.stop();
  call.device("active");
  call.connection("live");
  expect(call.events).toEqual(["active", "inactive"]);
});
