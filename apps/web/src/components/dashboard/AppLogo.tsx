import type { CSSProperties, ReactNode } from "react";

import { ChalkMark } from "../site/Lockup";

type KnownApp = { readonly match: RegExp; readonly file: string; /** Single-colour logos follow the theme's text colour; the rest keep their brand colours. */ readonly brand: boolean };

// Logos come from Svgl (svgl.app). Devin is not on Svgl, so its file is the mark from devin.ai.
const KNOWN_APPS: readonly KnownApp[] = [
  { match: /claude/i, file: "claude", brand: true },
  { match: /chatgpt|openai/i, file: "openai", brand: false },
  { match: /cursor/i, file: "cursor", brand: false },
  { match: /codex/i, file: "codex", brand: false },
  { match: /devin|cognition/i, file: "devin", brand: false },
  { match: /vs ?code|visual studio code/i, file: "vscode", brand: true },
];

function Tile({ className, children }: { readonly className?: string; readonly children?: ReactNode }) {
  return (
    <span className={className ? `alogo ${className}` : "alogo"} aria-hidden="true">
      {children}
    </span>
  );
}

/** The logo of the app that connects to Chalk, or its first letter when Chalk has no logo for it. */
export function AppLogo({ name, size = "md" }: { readonly name: string; readonly size?: "sm" | "md" | "lg" }) {
  const known = KNOWN_APPS.find((app) => app.match.test(name));
  const url = known ? `/brand/apps/${known.file}.svg` : null;
  return (
    <Tile className={size}>
      {known && url && known.brand ? <img src={url} alt="" /> : null}
      {known && url && !known.brand ? <span className="mono" style={{ "--logo": `url(${url})` } as CSSProperties} /> : null}
      {!known ? <span className="initial">{name.trim().charAt(0).toUpperCase()}</span> : null}
    </Tile>
  );
}

/** Chalk's own side of the pair. */
export function ChalkLogo({ size = "md" }: { readonly size?: "sm" | "md" | "lg" }) {
  return (
    <Tile className={size}>
      <ChalkMark />
    </Tile>
  );
}

/** The app and Chalk side by side. The connector is solid while they are connected and cut when they are not. With no known app there is only the Chalk mark. */
export function AppPair({ name, broken }: { readonly name: string | null; readonly broken?: boolean }) {
  if (!name)
    return (
      <div className="apair">
        <ChalkLogo size="lg" />
      </div>
    );
  return (
    <div className={broken ? "apair broken" : "apair"}>
      <AppLogo name={name} size="lg" />
      <svg className="aconn" viewBox="0 0 72 24" aria-hidden="true" focusable="false">
        {broken ? (
          <>
            <path d="M6 12h20M46 12h20" />
            <path className="cut" d="M31 19l10-14" />
          </>
        ) : (
          <>
            <path d="M14 12h44" strokeDasharray="1 6" />
            <path d="M12 6l-6 6 6 6M60 6l6 6-6 6" />
          </>
        )}
      </svg>
      <ChalkLogo size="lg" />
    </div>
  );
}
