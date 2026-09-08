"use client";

import type { Variants } from "motion/react";
import { motion, useAnimation } from "motion/react";
import type { SVGAttributes } from "react";
import { forwardRef } from "react";
import { useIconAnimation } from "../animated-icon-runtime";
import { cn } from "../cn";

export interface Download01IconHandle {
  startAnimation: () => void;
  stopAnimation: () => void;
}

export interface Download01IconProps extends SVGAttributes<SVGSVGElement> {
  size?: number | string;
}

// a conveyor: the arrow falls through, fades, and a new one drops in from
// above — the tray dips as each delivery lands
const arrowVariants: Variants = {
  normal: { translateY: 0, visibility: "visible" },
  animate: {
    translateY: [0, 5, -5, 0],
    visibility: ["visible", "hidden", "hidden", "visible"],
    transition: {
      duration: 0.7,
      times: [0, 0.42, 0.5, 1],
      ease: ["easeIn", "linear", "easeOut"],
    },
  },
};

const trayVariants: Variants = {
  normal: { translateY: 0 },
  animate: {
    translateY: [0, 1.2, 0],
    transition: { duration: 0.3, ease: "easeOut", delay: 0.32 },
  },
};

const Download01Icon = forwardRef<Download01IconHandle, Download01IconProps>(({ onMouseEnter, onMouseLeave, className, size = 24, ...props }, ref) => {
  const controls = useAnimation();
  const { handleMouseEnter, handleMouseLeave } = useIconAnimation({
    controls,
    loops: false,
    onMouseEnter,
    onMouseLeave,
    ref,
  });

  return (
    <div data-hugeicons-animated="true" className={cn("inline-flex", className)} style={{ strokeWidth: 1.5 }}>
      <svg className="h-full w-full" onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} {...props} xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" overflow="visible">
        <motion.path
          d="M2.99969 17.0002C2.99969 17.9302 2.99969 18.3952 3.10192 18.7767C3.37932 19.8119 4.18796 20.6206 5.22324 20.898C5.60474 21.0002 6.06972 21.0002 6.99969 21.0002L16.9997 21.0002C17.9297 21.0002 18.3947 21.0002 18.7762 20.898C19.8114 20.6206 20.6201 19.8119 20.8975 18.7767C20.9997 18.3952 20.9997 17.9302 20.9997 17.0002"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="inherit"
          variants={trayVariants}
          animate={controls}
          initial="normal"
        />
        <motion.path
          d="M16.4998 11.5002C16.4998 11.5002 13.1856 16.0002 11.9997 16.0002C10.8139 16.0002 7.49976 11.5002 7.49976 11.5002M11.9997 15.0002V3.00016"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="inherit"
          variants={arrowVariants}
          animate={controls}
          initial="normal"
        />
      </svg>
    </div>
  );
});

Download01Icon.displayName = "Download01Icon";

export { Download01Icon };
