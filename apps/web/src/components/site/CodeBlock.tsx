import { useState, type ReactNode } from "react";

import { CopyButton } from "./CopyButton";

export type CodeLanguage = "TSX" | "TypeScript" | "Shell";
export type CodeTab = { readonly label: string; readonly language: CodeLanguage; readonly source: string };

const TOKEN = /(\/\/[^\n]*)|("(?:[^"\\\n]|\\.)*"|'[^'\n]*'|`[^`]*`)|\b(import|from|export|function|return|const|let|await|async|if|throw|new|type|satisfies|try|finally)\b|(<\/?[A-Z][A-Za-z]*|\b[A-Z][A-Za-z]+\b)/g;
const SHELL_COMMAND = /^(pnpm|npm|git)\b/gm;

/** A small highlighter for the few samples on the site, so the page ships no syntax engine. */
function highlight(source: string, language: CodeLanguage): ReactNode[] {
  const pattern = language === "Shell" ? SHELL_COMMAND : TOKEN;
  const out: ReactNode[] = [];
  let last = 0;
  for (const match of source.matchAll(pattern)) {
    const at = match.index;
    out.push(source.slice(last, at));
    const className = language === "Shell" ? "tk" : match[1] ? "tc" : match[2] ? "ts" : match[3] ? "tk" : "tt";
    out.push(
      <span key={at} className={className}>
        {match[0]}
      </span>,
    );
    last = at + match[0].length;
  }
  out.push(source.slice(last));
  return out;
}

/** A code sample with its language, a copy button, and tabs when there is more than one. */
export function CodeBlock({ tabs, label }: { readonly tabs: readonly [CodeTab, ...CodeTab[]]; readonly label: string }) {
  const [index, setIndex] = useState(0);
  const current = tabs[index] ?? tabs[0];
  return (
    <div className="code">
      <div className="ch">
        {tabs.length > 1 ? (
          <>
            <div className="ctabs" role="group" aria-label={label}>
              {tabs.map((tab, i) => (
                <button key={tab.label} type="button" aria-pressed={i === index} onClick={() => setIndex(i)}>
                  {tab.label}
                </button>
              ))}
            </div>
            <span className="clang">{current.language}</span>
          </>
        ) : (
          <span className="clang">{current.label}</span>
        )}
        <CopyButton text={current.source} label="Copy code" />
      </div>
      <pre tabIndex={0} aria-label={`${current.label} code`}>
        <code>{highlight(current.source, current.language)}</code>
      </pre>
    </div>
  );
}
