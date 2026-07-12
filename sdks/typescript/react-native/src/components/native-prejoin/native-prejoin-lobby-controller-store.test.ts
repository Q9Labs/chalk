import { describe, expect, it, vi } from "vitest";
import { NativePreJoinLobbyControllerStore } from "./native-prejoin-lobby-controller-store";

function createStore(options: Partial<ConstructorParameters<typeof NativePreJoinLobbyControllerStore>[0]> = {}) {
  return new NativePreJoinLobbyControllerStore({
    displayName: "Guest",
    initialAudioEnabled: false,
    initialVideoEnabled: false,
    simulatorMediaDisabled: false,
    joinDisabled: false,
    onJoin: vi.fn(),
    ...options,
  });
}

describe("NativePreJoinLobbyControllerStore", () => {
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
    expect(onJoin).toHaveBeenCalledWith({ displayName: "Host", audioEnabled: true, videoEnabled: true });
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

  it("disables media and ignores toggles on the iOS simulator", () => {
    const store = createStore({ initialAudioEnabled: true, initialVideoEnabled: true });

    store.update({ simulatorMediaDisabled: true, joinDisabled: false, onJoin: vi.fn() });
    store.toggleAudio();
    store.toggleVideo();

    expect(store.getSnapshot()).toMatchObject({ audioEnabled: false, videoEnabled: false });
  });
});
