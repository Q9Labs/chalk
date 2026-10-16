import React from "react";
import { ClassicWhatsNewTrigger } from "./ClassicWhatsNewTrigger";

export interface WhatsNewTriggerProps {
  /** Whether there's unseen content */
  hasUnseen?: boolean;
  /** Click handler */
  onClick?: () => void;
  /** Additional class names */
  className?: string;
  /** Size variant */
  size?: "sm" | "md";
}

/**
 * Trigger button for What's New dialog with notification badge
 *
 * @example
 * ```tsx
 * const { hasSeen, open } = useWhatsNew();
 * <WhatsNewTrigger hasUnseen={!hasSeen} onClick={open} />
 * ```
 */
export const WhatsNewTrigger = React.memo<WhatsNewTriggerProps>((props) => {
  return <ClassicWhatsNewTrigger {...props} />;
});

WhatsNewTrigger.displayName = "WhatsNewTrigger";
