import { useRef, type ComponentPropsWithoutRef, type ReactNode } from "react";

import { CopyButton } from "../site/CopyButton";
import { Icon } from "../site/Icon";
import type { DocsCalloutProps, DocsFeatureCardProps } from "./docs-types";

const TONE_TITLES = { note: "Note", tip: "Tip", caution: "Caution", failure: "Failure" } as const;

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

export function CodeBlock({ children, ...props }: ComponentPropsWithoutRef<"pre">) {
  const preRef = useRef<HTMLPreElement>(null);
  return (
    <div className="code">
      <div className="ch">
        <span className="clang">Code</span>
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
