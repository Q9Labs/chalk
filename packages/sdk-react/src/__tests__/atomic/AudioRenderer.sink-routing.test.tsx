import { afterEach, describe, expect, it, vi } from "bun:test";
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

const mediaPrototype = globalThis.HTMLMediaElement.prototype as any;
const originalSetSinkIdDescriptor = Object.getOwnPropertyDescriptor(
	mediaPrototype,
	"setSinkId",
);

const makeTrack = (id: string) =>
	({
		id,
		readyState: "live",
		addEventListener: vi.fn(),
		removeEventListener: vi.fn(),
	}) as any;

afterEach(() => {
	if (originalSetSinkIdDescriptor) {
		Object.defineProperty(mediaPrototype, "setSinkId", originalSetSinkIdDescriptor);
		return;
	}
	delete mediaPrototype.setSinkId;
});

describe("AudioRenderer sink routing", () => {
	it("routes remote mic and screen-share audio to selected output device", async () => {
		(globalThis as any).MediaStream = FakeMediaStream;

		const setSinkId = vi
			.fn()
			.mockImplementation(function (this: any, sinkId: string) {
				this.sinkId = sinkId;
				return Promise.resolve();
			});
		Object.defineProperty(mediaPrototype, "setSinkId", {
			configurable: true,
			value: setSinkId,
		});

		const participant = {
			id: "remote-1",
			isLocal: false,
			audioTrack: makeTrack("audio-track-1"),
			screenShareAudioTrack: makeTrack("screen-track-1"),
		};

		const { rerender } = render(
			<AudioRenderer
				participants={[participant]}
				audioOutputDeviceId="spk-1"
			/>,
		);

		await act(async () => {});
		expect(setSinkId).toHaveBeenCalledTimes(2);
		expect(setSinkId).toHaveBeenNthCalledWith(1, "spk-1");
		expect(setSinkId).toHaveBeenNthCalledWith(2, "spk-1");

		rerender(
			<AudioRenderer
				participants={[participant]}
				audioOutputDeviceId="spk-2"
			/>,
		);

		await act(async () => {});
		expect(setSinkId).toHaveBeenCalledTimes(4);
		expect(setSinkId).toHaveBeenNthCalledWith(3, "spk-2");
		expect(setSinkId).toHaveBeenNthCalledWith(4, "spk-2");
	});

	it("does not fail when setSinkId is unsupported", async () => {
		(globalThis as any).MediaStream = FakeMediaStream;
		delete mediaPrototype.setSinkId;

		expect(() =>
			render(
				<AudioRenderer
					participants={[
						{
							id: "remote-1",
							isLocal: false,
							audioTrack: makeTrack("audio-track-1"),
						},
					]}
					audioOutputDeviceId="spk-1"
				/>,
			),
		).not.toThrow();
	});
});
