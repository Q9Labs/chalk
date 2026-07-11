import React, { useEffect, useMemo, useState } from "react";
import { Facehash } from "@q9labsai/facehash/react";
import { cn } from "../../utils/cn";
import { getParticipantAvatarRecipe, type ParticipantGradientPreference } from "../../utils/colorGenerator";

type FacehashComponentProps = {
  name: string;
  size?: number | string;
  variant?: "gradient" | "flat";
  intensity3d?: "subtle" | "medium" | "dramatic";
  interactive?: boolean;
  colors?: readonly string[];
  enableBlink?: boolean;
};

const GeneratedFacehash = Facehash as React.ComponentType<FacehashComponentProps>;

export interface AvatarProps {
  name: string;
  src?: string;
  size?: "xs" | "sm" | "md" | "lg" | "xl" | "2xl";
  status?: "online" | "away" | "busy" | "offline";
  className?: string;
  style?: React.CSSProperties;
  gradientPreference?: ParticipantGradientPreference;
  generated?: boolean;
}

const sizeMap = {
  xs: { size: 24, fontSize: "0.75rem" },
  sm: { size: 32, fontSize: "0.875rem" },
  md: { size: 48, fontSize: "1rem" },
  lg: { size: 64, fontSize: "1.5rem" },
  xl: { size: 96, fontSize: "2.25rem" },
  "2xl": { size: 120, fontSize: "2.75rem" },
};

const statusColorMap = {
  online: "var(--success)",
  away: "var(--warning)",
  busy: "var(--destructive)",
  offline: "var(--muted-foreground)",
};

export const Avatar = React.memo(({ name, src, size = "md", status, className, style, gradientPreference, generated = true }: AvatarProps) => {
  const [imageError, setImageError] = useState(false);
  const hasUploadedImage = Boolean(src) && !imageError;
  const shouldShowGeneratedAvatar = generated && Boolean(name) && !hasUploadedImage;

  useEffect(() => {
    setImageError(false);
  }, [src, name, generated]);

  const avatarRecipe = useMemo(() => getParticipantAvatarRecipe(name || "unknown", gradientPreference), [gradientPreference, name]);
  const gradient = avatarRecipe.avatarGradient;
  const { size: pxSize, fontSize } = sizeMap[size];

  return (
    <div className={cn("relative inline-flex shrink-0 rounded-full", className)} style={{ width: pxSize, height: pxSize, ...style }} role="img" aria-label={`Avatar for ${name || "Unknown"}`}>
      {hasUploadedImage ? (
        <img src={src || ""} alt={name} className="h-full w-full rounded-full object-cover" onError={() => setImageError(true)} />
      ) : shouldShowGeneratedAvatar ? (
        <div aria-hidden="true" className="h-full w-full overflow-hidden rounded-full">
          <GeneratedFacehash name={name || "guest"} size={pxSize} variant="gradient" interactive intensity3d="dramatic" enableBlink colors={[...avatarRecipe.facehashColors]} />
        </div>
      ) : (
        <div className="flex h-full w-full items-center justify-center rounded-full text-white font-medium" style={{ fontSize, background: gradient }}>
          {avatarRecipe.initials}
        </div>
      )}
      {status && (
        <span
          className="absolute bottom-0 right-0 block rounded-full ring-2 ring-background"
          style={{
            width: Math.max(8, pxSize / 4),
            height: Math.max(8, pxSize / 4),
            backgroundColor: statusColorMap[status],
          }}
        />
      )}
    </div>
  );
});

Avatar.displayName = "Avatar";
