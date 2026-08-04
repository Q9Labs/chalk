import { describe, expect, it, vi } from "vitest";
import { EntranceControllerStore } from "./entrance-controller-store";

function createStore(options: Partial<ConstructorParameters<typeof EntranceControllerStore>[0]> = {}) {
  return new EntranceControllerStore({
    displayName: "Guest",
    initialAudioEnabled: false,
    initialVideoEnabled: false,
    simulatorMediaDisabled: false,
    joinDisabled: false,
    onJoin: vi.fn(),
    ...options,
  });
}

describe("EntranceControllerStore", () => {
  it("toggles media, edits the name, and latches join", () => {
    const onJoin = vi.fn();
    const store = createStore({ onJoin });
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    store.setDisplayName("Host");
    store.toggleAudio();
    store.toggleVideo();
    store.setInputFocused(true);
    store.handleJoin();
    store.handleJoin();

    expect(store.getSnapshot()).toMatchObject({
      displayName: "Host",
      audioEnabled: true,
      videoEnabled: true,
      isInputFocused: true,
      isSubmitting: true,
    });
    expect(onJoin).toHaveBeenCalledTimes(1);
    expect(onJoin).toHaveBeenCalledWith({ displayName: "Host", microphoneEnabled: true, cameraEnabled: true });
    expect(listener).toHaveBeenCalled();

    unsubscribe();
  });

  it("resets the submit latch when joining is re-enabled", () => {
    const onJoin = vi.fn();
    const store = createStore({ joinDisabled: true, onJoin });

    store.handleJoin();
    expect(onJoin).not.toHaveBeenCalled();

    store.update({ simulatorMediaDisabled: false, joinDisabled: false, onJoin });
    store.handleJoin();
    expect(onJoin).toHaveBeenCalledTimes(1);
  });

  it("does not submit a blank display name", () => {
    const onJoin = vi.fn();
    const store = createStore({ displayName: "   ", onJoin });

    store.handleJoin();

    expect(onJoin).not.toHaveBeenCalled();
    expect(store.getSnapshot().isSubmitting).toBe(false);
  });

  it("disables media and ignores toggles on the iOS simulator", () => {
    const store = createStore({ initialAudioEnabled: true, initialVideoEnabled: true });

    store.update({ simulatorMediaDisabled: true, joinDisabled: false, onJoin: vi.fn() });
    store.toggleAudio();
    store.toggleVideo();

    expect(store.getSnapshot()).toMatchObject({ audioEnabled: false, videoEnabled: false });
  });
});
