import { useRef, type ComponentPropsWithoutRef, type ReactNode } from "react";

import { CopyButton } from "../site/CopyButton";
import { Icon } from "../site/Icon";
import type { DocsCalloutProps, DocsFeatureCardProps } from "./docs-types";

const TONE_TITLES = { note: "Note", tip: "Tip", caution: "Caution", failure: "Failure" } as const;
const LANGUAGE_LABELS = new Map([
  ["ts", "TypeScript"],
  ["tsx", "TSX"],
  ["sh", "Shell"],
  ["json", "JSON"],
  ["http", "HTTP"],
]);

export function Callout({ children, title, tone = "note" }: DocsCalloutProps) {
  const warning = tone === "caution" || tone === "failure";
  return (
    <div className={warning ? "callout caution" : "callout"} role="note">
      <Icon name={warning ? "warn" : "info"} />
      <div>
        <b>{title ?? TONE_TITLES[tone]}</b>
        <div className="callout-body">{children}</div>
      </div>
    </div>
  );
}

/** A row of short values, such as the steps of a schedule. */
export function Chips({ items, label }: { readonly items: readonly string[]; readonly label: string }) {
  return (
    <ul className="chips" aria-label={label}>
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}

export function CardGrid({ children }: { readonly children: ReactNode }) {
  return <div className="dlinks">{children}</div>;
}

export function FeatureCard({ children, href, title }: DocsFeatureCardProps) {
  return (
    <a href={href}>
      <b>
        {title}
        <Icon name="arrowR" />
      </b>
      <div>{children}</div>
    </a>
  );
}

/** Shiki puts the fence language on `data-language` (see the rehype-shiki transformer in vite.config.ts). */
export function CodeBlock({ children, "data-language": language, ...props }: ComponentPropsWithoutRef<"pre"> & { readonly "data-language"?: string }) {
  const preRef = useRef<HTMLPreElement>(null);
  return (
    <div className="code">
      <div className="ch">
        <span className="clang">{LANGUAGE_LABELS.get(language ?? "") ?? "Code"}</span>
        <CopyButton text={() => preRef.current?.textContent ?? ""} label="Copy code" />
      </div>
      <pre ref={preRef} {...props}>
        {children}
      </pre>
    </div>
  );
}

export function DocsLink({ children, href, ...props }: ComponentPropsWithoutRef<"a">) {
  return (
    <a href={href} className="tl" {...props}>
      {children}
    </a>
  );
}
