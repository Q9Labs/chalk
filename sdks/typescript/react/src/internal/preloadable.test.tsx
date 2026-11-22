import { expect, it } from "vitest";
import { preloadable } from "./preloadable";

it("forgets a failed download so the next preload tries again", async () => {
  let attempts = 0;
  const { preload } = preloadable<object>(() => {
    attempts += 1;
    return attempts === 1 ? Promise.reject(new Error("offline")) : Promise.resolve(() => null);
  });
  await expect(preload()).rejects.toThrow("offline");
  await expect(preload()).resolves.toBeTypeOf("function");
  expect(attempts).toBe(2);
});
