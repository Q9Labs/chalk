export interface StoppableAnimation {
  start(): void;
  stop(): void;
}

export type AnimationRefCallback<Node> = (node: Node | null) => void;

export function createAnimationRefController<Node>(createAnimations: () => readonly StoppableAnimation[]): AnimationRefCallback<Node> {
  let attached = false;
  let animations: readonly StoppableAnimation[] = [];

  return (node) => {
    if (node === null) {
      if (!attached) {
        return;
      }

      attached = false;
      for (const animation of animations) {
        animation.stop();
      }
      animations = [];
      return;
    }

    if (attached) {
      return;
    }

    attached = true;
    animations = createAnimations();
    for (const animation of animations) {
      animation.start();
    }
  };
}
