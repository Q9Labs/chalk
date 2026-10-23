// @vitest-environment happy-dom
import { expect, it } from "vitest";

it("cancels an animation without an unhandled finished rejection", async () => {
  const animation = document.createElement("div").animate([{ opacity: 0 }, { opacity: 1 }], { duration: 1000 });
  animation.cancel();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(animation.playState).toBe("idle");
});

it("still rejects the cancelled finished promise for consumers", async () => {
  const animation = document.createElement("div").animate([{ opacity: 0 }, { opacity: 1 }], { duration: 1000 });
  const finished = animation.finished;
  animation.cancel();
  await expect(finished).rejects.toMatchObject({ name: "AbortError" });
});
