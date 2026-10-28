import type { ActiveReaction } from "@q9labsai/chalk-client";
import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePrefersReducedMotion } from "../../internal/useMediaQuery";
import { useReactions } from "../../bindings/hooks";
import { cn } from "../../utils/cn";
import { ReactionBubble } from "../atomic";
import { reactionPresentationStyle } from "./reaction-float";

export interface ReactionsOverlayProps {
  readonly maxVisible?: number;
  readonly className?: string;
}

export interface ReactionsOverlayPresentationReaction {
  readonly id: string;
  readonly displayName: string;
  readonly value: string;
  readonly occurredAtMs: number;
  readonly expiresAtMs: number;
}

export interface ReactionsOverlayPresentationProps extends ReactionsOverlayProps {
  readonly reactions: readonly ReactionsOverlayPresentationReaction[];
  readonly elapsedMs: number;
}

export function ReactionsOverlayPresentation({ reactions, elapsedMs, maxVisible = 6, className }: ReactionsOverlayPresentationProps): React.JSX.Element {
  return (
    <div className={cn("pointer-events-none absolute inset-0 z-30 overflow-hidden", className)} aria-live="off">
      {reactions.slice(-maxVisible).map((reaction) => {
        const duration = Math.max(1, reaction.expiresAtMs - reaction.occurredAtMs);
        const progress = (elapsedMs - reaction.occurredAtMs) / duration;
        return (
          <div key={reaction.id} className="absolute" style={reactionPresentationStyle(reaction.id, progress)}>
            <ReactionBubble emoji={reaction.value} participantName={reaction.displayName} duration={duration} animated={false} seed={reaction.id} />
          </div>
        );
      })}
    </div>
  );
}

interface ReactionsOverlaySurfaceProps extends ReactionsOverlayProps {
  readonly reactions: readonly ActiveReaction[];
}

export function ReactionsOverlaySurface({ reactions, maxVisible = 6, className }: ReactionsOverlaySurfaceProps): React.JSX.Element {
  const root = useRef<HTMLDivElement>(null);
  return (
    <div ref={root} className={cn("pointer-events-none absolute inset-0 z-30", className)} aria-live="polite" aria-atomic="false">
      {reactions.slice(-maxVisible).map((reaction) => (
        <TileReaction key={reaction.eventId} reaction={reaction} root={root} />
      ))}
    </div>
  );
}
function TileReaction({ reaction, root }: { readonly reaction: ActiveReaction; readonly root: React.RefObject<HTMLDivElement | null> }) {
  const [host, setHost] = useState<Element | null>(null);
  const emoji = useRef<HTMLSpanElement>(null);
  const reduced = usePrefersReducedMotion();
  // ast-grep-ignore: chalk.forbid-sdk-use-effect-tsx -- Keep existing reaction host lookup and cancellable animation.
  useEffect(() => {
    const frame = root.current?.closest("[data-part=call-frame]");
    const tile = Array.from(frame?.querySelectorAll<HTMLElement>("[data-stage-item]") ?? []).find((element) => element.dataset.stageItem === reaction.participantId && element.getAttribute("aria-hidden") !== "true");
    setHost(tile?.firstElementChild ?? root.current);
  }, [reaction.participantId, root]);
  // ast-grep-ignore: chalk.forbid-sdk-use-effect-tsx -- Keep existing reaction host lookup and cancellable animation.
  useEffect(() => {
    const element = emoji.current;
    if (!element || !host) return;
    const animation = element.animate(
      reduced
        ? [{ opacity: 0 }, { opacity: 1, offset: 0.2 }, { opacity: 0 }]
        : [
            { opacity: 0, transform: "translate(-50%,12px)" },
            { opacity: 1, offset: 0.15 },
            { opacity: 0, transform: "translate(-50%,-70px)" },
          ],
      { duration: 2000, easing: "ease-out", fill: "forwards" },
    );
    return () => animation.cancel();
  }, [host, reduced]);
  return (
    <>
      <span className="sr-only">
        {reaction.displayName} reacted {reaction.reaction}
      </span>
      {host
        ? createPortal(
            <span ref={emoji} aria-hidden="true" className="pointer-events-none absolute bottom-[28%] left-1/2 z-40 text-[44px] leading-[1.4]" style={{ transform: "translateX(-50%)" }}>
              {reaction.reaction}
            </span>,
            host,
          )
        : null}
    </>
  );
}

export function ReactionsOverlay(props: ReactionsOverlayProps): React.JSX.Element {
  const reactions = useReactions();
  return <ReactionsOverlaySurface {...props} reactions={reactions.active} />;
}
