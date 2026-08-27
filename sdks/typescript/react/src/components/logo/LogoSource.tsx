import type React from "react";

import { Logo } from "./Logo";

interface LogoSourceProps {
  readonly className?: string;
  readonly height: number;
  readonly logoUrl?: string;
}

const CANONICAL_LOGO_URL = /(?:^|\/)chalk-logo(?:-on-dark)?\.svg(?:[?#].*)?$/u;
const CANONICAL_ON_DARK_LOGO_URL = /(?:^|\/)chalk-logo-on-dark\.svg(?:[?#].*)?$/u;

export function LogoSource({ className, height, logoUrl }: LogoSourceProps): React.JSX.Element {
  if (!logoUrl || CANONICAL_LOGO_URL.test(logoUrl)) {
    const color = logoUrl && CANONICAL_ON_DARK_LOGO_URL.test(logoUrl) ? "#F4F3EE" : "currentColor";
    return <Logo color={color} height={height} />;
  }

  return <img alt="Chalk" className={className} draggable={false} src={logoUrl} />;
}
