import { describe, expect, it, vi } from "vitest";
import { createAnimationRefController, type StoppableAnimation } from "./native-animation-controller";

function createAnimation(): StoppableAnimation {
  return {
    start: vi.fn(),
    stop: vi.fn(),
  };
}

describe("createAnimationRefController", () => {
  it("starts animations once per attachment and stops them on detachment", () => {
    const firstAnimation = createAnimation();
    const secondAnimation = createAnimation();
    const ref = createAnimationRefController(() => [firstAnimation, secondAnimation]);

    ref({});
    ref({});

    expect(firstAnimation.start).toHaveBeenCalledOnce();
    expect(secondAnimation.start).toHaveBeenCalledOnce();
    expect(firstAnimation.stop).not.toHaveBeenCalled();

    ref(null);
    ref(null);

    expect(firstAnimation.stop).toHaveBeenCalledOnce();
    expect(secondAnimation.stop).toHaveBeenCalledOnce();
  });

  it("creates a fresh animation set when a node is attached again", () => {
    const firstAnimation = createAnimation();
    const secondAnimation = createAnimation();
    const createAnimations = vi.fn().mockReturnValueOnce([firstAnimation]).mockReturnValueOnce([secondAnimation]);
    const ref = createAnimationRefController(createAnimations);

    ref({});
    ref(null);
    ref({});

    expect(createAnimations).toHaveBeenCalledTimes(2);
    expect(firstAnimation.start).toHaveBeenCalledOnce();
    expect(firstAnimation.stop).toHaveBeenCalledOnce();
    expect(secondAnimation.start).toHaveBeenCalledOnce();
    expect(secondAnimation.stop).not.toHaveBeenCalled();
  });
});
