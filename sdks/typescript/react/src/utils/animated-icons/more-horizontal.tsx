"use client";

import type { Variants } from "motion/react";
import { motion, useAnimation } from "motion/react";
import type { SVGAttributes } from "react";
import { forwardRef } from "react";
import { useIconAnimation } from "../animated-icon-runtime";
import { cn } from "../cn";

export interface MoreHorizontalIconHandle {
  startAnimation: () => void;
  stopAnimation: () => void;
}

export interface MoreHorizontalIconProps extends SVGAttributes<SVGSVGElement> {
  size?: number | string;
}

const dotVariants: Variants = {
  normal: { translateY: 0, scale: 1 },
  animate: (i: number) => ({
    translateY: [0, -1.5, 0.35, 0],
    scale: [1, 1.2, 0.95, 1],
    transition: { duration: 0.42, ease: "easeOut", delay: i * 0.08 },
  }),
};

const DOT_CENTERS = [6, 12, 18];

const MoreHorizontalIcon = forwardRef<MoreHorizontalIconHandle, MoreHorizontalIconProps>(({ onMouseEnter, onMouseLeave, className, size = 24, ...props }, ref) => {
  const controls = useAnimation();
  const { handleMouseEnter, handleMouseLeave } = useIconAnimation({
    controls,
    onMouseEnter,
    onMouseLeave,
    ref,
  });

  return (
    <div data-hugeicons-animated="true" className={cn("inline-flex", className)} style={{ strokeWidth: 1.5 }}>
      <svg className="h-full w-full" onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} {...props} xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" overflow="visible">
        {DOT_CENTERS.map((cx, index) => (
          <motion.circle key={cx} cx={cx} cy="12" r="1.25" fill="currentColor" variants={dotVariants} custom={index} animate={controls} initial="normal" style={{ transformOrigin: `${cx}px 12px` }} />
        ))}
      </svg>
    </div>
  );
});

MoreHorizontalIcon.displayName = "MoreHorizontalIcon";

export { MoreHorizontalIcon };
