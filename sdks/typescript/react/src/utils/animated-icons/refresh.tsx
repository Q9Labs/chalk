"use client";

import type { Variants } from "motion/react";
import { motion, useAnimation } from "motion/react";
import type { SVGAttributes } from "react";
import { forwardRef } from "react";
import { useIconAnimation } from "../animated-icon-runtime";
import { cn } from "../cn";

export interface RefreshIconHandle {
  startAnimation: () => void;
  stopAnimation: () => void;
}

export interface RefreshIconProps extends SVGAttributes<SVGSVGElement> {
  size?: number | string;
}

// rewinds slightly, then whips a full revolution; 360 ≡ 0 so the reset is
// invisible. Exit eases briefly instead of snapping mid-spin.
const svgVariants: Variants = {
  normal: { rotate: 0, transition: { duration: 0.15, ease: "easeOut" } },
  animate: {
    rotate: [0, -25, 360],
    transition: { duration: 0.9, times: [0, 0.2, 1], ease: ["easeIn", "easeOut"] },
  },
};

const RefreshIcon = forwardRef<RefreshIconHandle, RefreshIconProps>(({ onMouseEnter, onMouseLeave, className, size = 24, ...props }, ref) => {
  const controls = useAnimation();
  const { handleMouseEnter, handleMouseLeave } = useIconAnimation({
    controls,
    loops: false,
    onMouseEnter,
    onMouseLeave,
    ref,
  });

  return (
    <div className={cn("inline-flex", className)} style={{ strokeWidth: 1.5 }} data-hugeicons-animated="true">
      <svg onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} {...props} className="h-full w-full" xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" overflow="visible">
        <motion.g variants={svgVariants} animate={controls} initial="normal">
          <path d="M20.0092 2V5.13219C20.0092 5.42605 19.6418 5.55908 19.4537 5.33333C17.6226 3.2875 14.9617 2 12 2C6.47715 2 2 6.47715 2 12C2 17.5228 6.47715 22 12 22C17.5228 22 22 17.5228 22 12" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="inherit" />
        </motion.g>
      </svg>
    </div>
  );
});

RefreshIcon.displayName = "RefreshIcon";

export { RefreshIcon };
