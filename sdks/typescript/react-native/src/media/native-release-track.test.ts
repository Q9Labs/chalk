import { expect, it, vi } from "vitest";
import { releaseNativeTrack } from "./native-release-track";

function nativeTrack() {
  const calls: string[] = [];
  const track = { stop: vi.fn(() => void calls.push("stop")), release: vi.fn(() => void calls.push("release")) };
  return { track: track as unknown as MediaStreamTrack, calls, release: track.release };
}

it("stops the track, then releases the native capture", () => {
  const { track, calls } = nativeTrack();
  releaseNativeTrack(track);
  expect(calls).toEqual(["stop", "release"]);
});

it("releases a track once when the idle timer and Leave both reach it", () => {
  const { track, release } = nativeTrack();
  releaseNativeTrack(track);
  releaseNativeTrack(track);
  expect(release).toHaveBeenCalledOnce();
});

it("only stops a track that has no release()", () => {
  const stop = vi.fn();
  expect(() => releaseNativeTrack({ stop } as unknown as MediaStreamTrack)).not.toThrow();
  expect(stop).toHaveBeenCalledOnce();
});
