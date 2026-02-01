import { afterEach, describe, expect, it, mock } from "bun:test";
import { withPatchedGetDisplayMedia } from "../utils/get-display-media-fallback.ts";

const setNavigator = (value: any) => {
	Object.defineProperty(globalThis, "navigator", {
		value,
		configurable: true,
		writable: true,
	});
};

describe("withPatchedGetDisplayMedia", () => {
	const originalNavigator = (globalThis as any).navigator;

	afterEach(() => {
		setNavigator(originalNavigator);
	});

	it("forces audio=false when withAudio is not requested", async () => {
		const calls: any[] = [];
		const getDisplayMedia = mock(async (constraints: any) => {
			calls.push(constraints);
			return { stream: true, constraints };
		});

		setNavigator({ mediaDevices: { getDisplayMedia } });

		await withPatchedGetDisplayMedia(
			async () => {
				await (navigator as any).mediaDevices.getDisplayMedia({
					audio: true,
					video: { width: { max: 1920 } },
				});
				return true;
			},
			{ withAudio: false },
		);

		expect(calls.length).toBe(1);
		expect(calls[0].audio).toBe(false);
		expect(typeof calls[0].video).toBe("object");
	});

	it("retries without audio when audio=true fails", async () => {
		const calls: any[] = [];
		const getDisplayMedia = mock(async (constraints: any) => {
			calls.push(constraints);
			if (constraints?.audio === true) {
				const err = new Error("Could not start with audio");
				(err as any).name = "NotReadableError";
				throw err;
			}
			return { ok: true };
		});

		setNavigator({ mediaDevices: { getDisplayMedia } });

		await withPatchedGetDisplayMedia(
			async () => {
				await (navigator as any).mediaDevices.getDisplayMedia({
					audio: true,
					video: { width: { max: 1920 } },
				});
				return true;
			},
			{ withAudio: true },
		);

		expect(calls.length).toBe(2);
		expect(calls[0].audio).toBe(true);
		expect(calls[1].audio).toBe(false);
	});

	it("retries with video-only when constraints are overconstrained", async () => {
		const calls: any[] = [];
		const getDisplayMedia = mock(async (constraints: any) => {
			calls.push(constraints);
			const err = new Error("Overconstrained");
			(err as any).name = "OverconstrainedError";
			throw err;
		});

		setNavigator({ mediaDevices: { getDisplayMedia } });

		await expect(
			withPatchedGetDisplayMedia(
				async () => {
					await (navigator as any).mediaDevices.getDisplayMedia({
						audio: true,
						video: { width: { max: 1920 } },
					});
					return true;
				},
				{ withAudio: true },
			),
		).rejects.toBeTruthy();

		// 1) original, 2) no-audio, 3) video-only
		expect(calls.length).toBe(3);
		expect(calls[2]).toEqual({ video: true });
	});

	it("restores the original getDisplayMedia after run()", async () => {
		const getDisplayMedia = mock(async () => ({ ok: true }));
		const md = { getDisplayMedia };
		setNavigator({ mediaDevices: md });

		const before = md.getDisplayMedia;

		await withPatchedGetDisplayMedia(async () => true);

		expect(md.getDisplayMedia).toBe(before);
	});
});

