import { cn } from "../lib/utils";

interface ChalkLoaderProps {
  className?: string;
  size?: number;
}

/**
 * An animated version of the Chalk logo that "draws" or pops into existence.
 * Animations are defined in global styles.css
 */
export function ChalkLoader({ className, size = 64 }: ChalkLoaderProps) {
  return (
    <div className={cn("relative flex items-center justify-center", className)} style={{ width: size, height: size }}>
      <svg
        width={size}
        height={size}
        viewBox="0 0 64 64"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="overflow-visible"
      >
        {/* Green chalk */}
        <g className="chalk-group chalk-s1">
          <g className="chalk-float-layer chalk-f1">
            <rect x="8" y="16" width="12" height="40" rx="6" fill="#A8D5A2" />
            <ellipse cx="14" cy="16" rx="6" ry="3.5" fill="#8BC585" />
          </g>
        </g>

        {/* Yellow chalk */}
        <g className="chalk-group chalk-s2">
          <g className="chalk-float-layer chalk-f2">
            <rect x="18" y="12" width="12" height="44" rx="6" fill="#F5D76E" />
            <ellipse cx="24" cy="12" rx="6" ry="3.5" fill="#E8C85A" />
          </g>
        </g>

        {/* Blue chalk */}
        <g className="chalk-group chalk-s3">
          <g className="chalk-float-layer chalk-f3">
            <rect x="28" y="4" width="12" height="42" rx="6" fill="#7EC8E3" />
            <ellipse cx="34" cy="4" rx="6" ry="3.5" fill="#5FB8D9" />
          </g>
        </g>

        {/* Pink chalk */}
        <g className="chalk-group chalk-s4">
          <g className="chalk-float-layer chalk-f4">
            <rect x="38" y="18" width="12" height="38" rx="6" fill="#F0A0A0" />
            <ellipse cx="44" cy="56" rx="6" ry="3.5" fill="#E88888" />
          </g>
        </g>
      </svg>

      {/* Subtle pulse ring */}
      <div className="absolute inset-0 rounded-full border-2 border-primary/20 animate-ping opacity-20" />
    </div>
  );
}
