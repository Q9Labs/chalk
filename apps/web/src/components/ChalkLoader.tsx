import { cn } from "../lib/utils";

interface ChalkLoaderProps {
  className?: string;
  size?: number;
}

/**
 * An animated version of the Chalk logo that bounces in a smooth wave.
 * Animations are defined in global styles.css
 */
export function ChalkLoader({ className, size = 64 }: ChalkLoaderProps) {
  return (
    <div className={cn("relative flex items-center justify-center", className)} style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" className="overflow-visible">
        <defs>
          <linearGradient id="loader-grn" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stop-color="#C5E5C0" />
            <stop offset="100%" stop-color="#80B879" />
          </linearGradient>
          <linearGradient id="loader-yel" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stop-color="#FCEAB3" />
            <stop offset="100%" stop-color="#D9B641" />
          </linearGradient>
          <linearGradient id="loader-blu" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stop-color="#B2E0F0" />
            <stop offset="100%" stop-color="#55AAC9" />
          </linearGradient>
          <linearGradient id="loader-pnk" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stop-color="#F8CACA" />
            <stop offset="100%" stop-color="#D67B7B" />
          </linearGradient>
        </defs>

        <g transform="translate(5, 5) scale(0.85)">
          {/* Green chalk */}
          <g className="chalk-stick chalk-s1">
            <g transform="rotate(-20 16 48)">
              <path d="M9,16 L19,16 L20,50 A6,6 0 0 1 8,50 Z" fill="url(#loader-grn)" />
              <ellipse cx="14" cy="16" rx="5" ry="2" fill="#D8ECD4" />
            </g>
          </g>

          {/* Yellow chalk */}
          <g className="chalk-stick chalk-s2">
            <g transform="rotate(-5 24 44)">
              <path d="M19,12 L29,12 L30,50 A6,6 0 0 1 18,50 Z" fill="url(#loader-yel)" />
              <ellipse cx="24" cy="12" rx="5" ry="2" fill="#FEF3D1" />
            </g>
          </g>

          {/* Blue chalk */}
          <g className="chalk-stick chalk-s3">
            <g transform="rotate(25 44 20)">
              <path d="M29,4 L39,4 L40,40 A6,6 0 0 1 28,40 Z" fill="url(#loader-blu)" />
              <ellipse cx="34" cy="4" rx="5" ry="2" fill="#D0EDF8" />
            </g>
          </g>

          {/* Pink chalk */}
          <g className="chalk-stick chalk-s4">
            <g transform="rotate(10 44 40)">
              <path d="M39,56 L49,56 L50,24 A6,6 0 0 0 38,24 Z" fill="url(#loader-pnk)" />
              <ellipse cx="44" cy="56" rx="5" ry="2" fill="#FBE4E4" />
            </g>
          </g>
        </g>
      </svg>
    </div>
  );
}
