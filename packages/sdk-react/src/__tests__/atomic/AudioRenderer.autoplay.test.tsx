import { describe, expect, it, vi } from "bun:test";
import { act, render } from "@testing-library/react";
import { AudioRenderer } from "../../components/atomic/AudioRenderer";

class FakeMediaStream {
	private readonly tracks: any[];
	constructor(tracks: any[]) {
		this.tracks = tracks;
	}
	getAudioTracks() {
		return this.tracks;
	}
}

describe("AudioRenderer autoplay recovery", () => {
	it("retries play() on user interaction after autoplay is blocked", async () => {
		(globalThis as any).MediaStream = FakeMediaStream;

		const playSpy = vi
			.spyOn(globalThis.HTMLMediaElement.prototype, "play")
			.mockRejectedValueOnce(new Error("NotAllowedError"))
			.mockResolvedValue(undefined);

		const audioTrack = {
			id: "track-1",
			readyState: "live",
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
		} as any;

		render(
			<AudioRenderer
				participants={[
					{
						id: "p-1",
						isLocal: false,
						audioTrack,
					},
				]}
			/>,
		);

		// Let effects run: first play() attempt should be blocked.
		await act(async () => {});

		expect(playSpy).toHaveBeenCalledTimes(1);

		// Simulate a user gesture; AudioRenderer should retry play().
		await act(async () => {
			window.dispatchEvent(new Event("pointerdown"));
		});

		expect(playSpy).toHaveBeenCalledTimes(2);

		// Once unlocked, further gestures should not cause extra play() attempts.
		const callsAfterUnlock = playSpy.mock.calls.length;
		await act(async () => {
			window.dispatchEvent(new Event("pointerdown"));
		});
		expect(playSpy.mock.calls.length).toBe(callsAfterUnlock);
	});
});

