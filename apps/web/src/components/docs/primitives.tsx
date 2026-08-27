import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { AnimatedCopy01Icon, type AnimatedCopy01IconHandle } from "@q9labsai/chalk-react/utils";

import type { DocsCalloutProps, DocsFeatureCardProps, DocsTone } from "./docs-types";

const TONE_LABELS: Record<DocsTone, string> = {
  note: "Note",
  tip: "Tip",
  caution: "Caution",
  failure: "Failure",
};

export function Callout({ children, title, tone = "note" }: DocsCalloutProps) {
  return (
    <aside className="docs-callout" data-tone={tone}>
      <div className="docs-callout-label">{title ?? TONE_LABELS[tone]}</div>
      <div className="docs-callout-content">{children}</div>
    </aside>
  );
}

export function CardGrid({ children }: { children: ReactNode }) {
  return <div className="docs-card-grid">{children}</div>;
}

export function FeatureCard({ children, description, eyebrow, href, icon, title }: DocsFeatureCardProps) {
  const content = (
    <>
      {icon ? (
        <span className="docs-feature-card-icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      {eyebrow ? <span className="docs-feature-card-eyebrow">{eyebrow}</span> : null}
      <h3>{title}</h3>
      {description ? <p>{description}</p> : null}
      {children ? <div className="docs-feature-card-body">{children}</div> : null}
    </>
  );

  if (href) {
    return (
      <a className="docs-feature-card" href={href}>
        {content}
      </a>
    );
  }

  return <article className="docs-feature-card">{content}</article>;
}

type CodeBlockProps = ComponentPropsWithoutRef<"pre">;
type CopyState = "idle" | "copied" | "error";

export function CodeBlock({ children, className, ...props }: CodeBlockProps) {
  const codeRef = useRef<HTMLPreElement>(null);
  const copyIconRef = useRef<AnimatedCopy01IconHandle>(null);
  const [copyState, setCopyState] = useState<CopyState>("idle");

  useEffect(() => {
    if (copyState === "idle") return;
    const timeout = window.setTimeout(() => setCopyState("idle"), 2200);
    return () => window.clearTimeout(timeout);
  }, [copyState]);

  async function copyCode() {
    const source = codeRef.current?.querySelector("code")?.textContent ?? codeRef.current?.textContent ?? "";

    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard access is unavailable");
      await navigator.clipboard.writeText(source);
      setCopyState("copied");
      copyIconRef.current?.startAnimation();
    } catch {
      setCopyState("error");
    }
  }

  const copyLabel = copyState === "copied" ? "Copied" : copyState === "error" ? "Copy failed" : "Copy";
  const stateMessage = copyState === "error" ? "Copy failed. Select the code to copy it manually." : copyState === "copied" ? "Code copied to clipboard." : "";

  return (
    <div className="docs-code-block">
      <div className="docs-code-toolbar">
        <span className="docs-code-label">Code</span>
        <button className="docs-code-copy" type="button" onClick={() => void copyCode()} onMouseEnter={() => copyIconRef.current?.startAnimation()} onFocus={() => copyIconRef.current?.startAnimation()}>
          <AnimatedCopy01Icon ref={copyIconRef} size={15} aria-hidden="true" onMouseEnter={() => copyIconRef.current?.startAnimation()} />
          {copyLabel}
        </button>
      </div>
      <pre ref={codeRef} className={className ? `docs-code-pre ${className}` : "docs-code-pre"} {...props}>
        {children}
      </pre>
      <p className="docs-code-status" aria-live="polite">
        {stateMessage}
      </p>
    </div>
  );
}

export function InlineCode({ children, className, ...props }: ComponentPropsWithoutRef<"code">) {
  return (
    <code className={className ? `docs-inline-code ${className}` : "docs-inline-code"} {...props}>
      {children}
    </code>
  );
}

export function DocsLink({ children, href, ...props }: ComponentPropsWithoutRef<"a">) {
  return (
    <a href={href} {...props}>
      {children}
    </a>
  );
}
