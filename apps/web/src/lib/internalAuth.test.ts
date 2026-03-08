import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyMagicLink } from "./internalAuth";

describe("verifyMagicLink", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("dedupes concurrent verification requests for the same token", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({}),
		});
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as typeof fetch);

		await Promise.all([
			verifyMagicLink("https://chalk-api.q9labs.ai", "token-123"),
			verifyMagicLink("https://chalk-api.q9labs.ai", "token-123"),
		]);

		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("does not cache failed verification attempts", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce({
				ok: false,
				json: async () => ({ error: "invalid or expired token" }),
			})
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({}),
			});
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as typeof fetch);

		await expect(
			verifyMagicLink("https://chalk-api.q9labs.ai", "token-456"),
		).rejects.toThrow("invalid or expired token");

		await expect(
			verifyMagicLink("https://chalk-api.q9labs.ai", "token-456"),
		).resolves.toBeUndefined();

		expect(fetchMock).toHaveBeenCalledTimes(2);
	});
});
