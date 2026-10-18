import React, { Component, type ReactNode, type RefObject } from "react";
import { captureFlip } from "../../internal/call-motion";

interface StageMotionProps {
  readonly rootRef: RefObject<HTMLDivElement | null>;
  readonly motionKey: string;
  readonly animate: boolean;
  readonly children: ReactNode;
}

interface StageSnapshot {
  readonly play: () => void;
  readonly previous: ReadonlySet<HTMLElement>;
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

  getSnapshotBeforeUpdate(previous: StageMotionProps): StageSnapshot | null {
    if (!this.props.animate || !this.animationsSupported() || previous.motionKey === this.props.motionKey) return null;
    const elements = this.elements();
    return { play: captureFlip(elements), previous: new Set(elements) };
  }

  componentDidUpdate(previous: StageMotionProps, _state: unknown, snapshot: StageSnapshot | null): void {
    if (!this.animationsSupported()) return;
    if (!this.props.animate && previous.animate) {
      for (const element of this.elements()) for (const animation of element.getAnimations()) animation.cancel();
    }
    if (!snapshot) return;
    const elements = this.elements();
    for (const element of elements) {
      if (!element.hasAttribute("data-leaving")) for (const animation of element.getAnimations()) if (animation.id === "stage-exit") animation.cancel();
    }
    snapshot.play();
    for (const element of elements) {
      if (element.getAttribute("aria-hidden") === "true") continue;
      if (element.hasAttribute("data-leaving")) {
        if (element.getAnimations().some((animation) => animation.id === "stage-exit")) continue;
        const exit = element.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: "ease-out", fill: "forwards" });
        exit.id = "stage-exit";
      } else if (!snapshot.previous.has(element)) {
        const transform = getComputedStyle(element).transform;
        element.animate(
          [
            { opacity: 0, transform: `${transform} scale(.97)` },
            { opacity: 1, transform },
          ],
          { duration: 220, easing: "cubic-bezier(.2,.8,.2,1)" },
        );
      }
    }
  }

  componentWillUnmount(): void {
    if (!this.animationsSupported()) return;
    for (const element of this.elements()) for (const animation of element.getAnimations()) animation.cancel();
  }

  render(): React.JSX.Element {
    return (
      <div ref={this.props.rootRef} className="relative h-full w-full">
        {this.props.children}
      </div>
    );
  }
}
