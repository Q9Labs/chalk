import React, { Component, type ReactNode, type RefObject } from "react";
import { captureFlip } from "../../internal/call-motion";
import { WHITEBOARD_ITEM_ID } from "./stage-items";

interface StageMotionProps {
  readonly rootRef: RefObject<HTMLDivElement | null>;
  readonly motionKey: string;
  readonly animate: boolean;
  readonly children: ReactNode;
}

interface StageSnapshot {
  play: (() => void) | null;
  readonly previous: Set<HTMLElement>;
}

/** Snapshot before React mutates tile boxes, not after an animation has started. */
export class StageMotion extends Component<StageMotionProps> {
  private animationsSupported(): boolean {
    const root = this.props.rootRef.current;
    return Boolean(root && typeof root.animate === "function" && typeof root.getAnimations === "function");
  }

  private elements(): HTMLElement[] {
    return Array.from(this.props.rootRef.current?.querySelectorAll<HTMLElement>(":scope > [data-stage-item]") ?? []);
  }

  override getSnapshotBeforeUpdate(previous: StageMotionProps): StageSnapshot | null {
    if (!this.props.animate || !this.animationsSupported() || previous.motionKey === this.props.motionKey) return null;
    const elements = this.elements();
    // The live canvas measures its viewport during layout; transforms would
    // leave its renderer using an intermediate size and pointer origin.
    return { play: captureFlip(elements.filter((element) => element.dataset.stageItem !== WHITEBOARD_ITEM_ID)), previous: new Set(elements) };
  }

  override componentDidUpdate(previous: StageMotionProps, _state: unknown, snapshot: StageSnapshot | null): void {
    if (!this.animationsSupported()) return;
    if (!this.props.animate && previous.animate) {
      for (const element of this.elements()) for (const animation of element.getAnimations()) animation.cancel();
    }
    if (!snapshot) return;
    const elements = this.elements();
    const entering = new Set(elements.filter((element) => !snapshot.previous.has(element)));
    const play = snapshot.play;
    // React keeps its last snapshot on the instance after this lifecycle returns.
    snapshot.play = null;
    snapshot.previous.clear();
    for (const element of elements) {
      if (!element.hasAttribute("data-leaving")) for (const animation of element.getAnimations()) if (animation.id === "stage-exit") animation.cancel();
    }
    play?.();
    // ResizeObserver runs after animation sampling. Use its current frame rather
    // than letting pending WAAPI moves start one compositor frame after the card.
    const frameTime = document.timeline.currentTime;
    for (const element of elements) {
      for (const animation of element.getAnimations()) if (animation.startTime === null) animation.startTime = frameTime;
      if (element.getAttribute("aria-hidden") === "true") continue;
      if (element.hasAttribute("data-leaving")) {
        if (element.getAnimations().some((animation) => animation.id === "stage-exit")) continue;
        const exit = element.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: "ease-out", fill: "forwards" });
        exit.id = "stage-exit";
        exit.startTime = frameTime;
      } else if (entering.has(element)) {
        const transform = getComputedStyle(element).transform;
        const enter = element.animate(
          element.dataset.stageItem === WHITEBOARD_ITEM_ID
            ? [{ opacity: 0 }, { opacity: 1 }]
            : [
                { opacity: 0, transform: `${transform} scale(.97)` },
                { opacity: 1, transform },
              ],
          { duration: 220, easing: "cubic-bezier(.2,.8,.2,1)" },
        );
        enter.startTime = frameTime;
      }
    }
  }

  override componentWillUnmount(): void {
    if (!this.animationsSupported()) return;
    for (const element of this.elements()) for (const animation of element.getAnimations()) animation.cancel();
  }

  override render(): React.JSX.Element {
    return (
      <div ref={this.props.rootRef} className="relative h-full w-full">
        {this.props.children}
      </div>
    );
  }
}
