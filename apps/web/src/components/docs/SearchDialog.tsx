import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { DOCS_GROUPS, DOCS_PAGES } from "../../docs/manifest";
import { Icon } from "../site/Icon";
import { trapDialogFocus } from "./dialog-focus";
import { searchDocsPages } from "./search";

function highlight(text: string, query: string): ReactNode {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return text;
  const pattern = new RegExp(`(${words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  return text.split(pattern).map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : part));
}

export function SearchDialog({ onClose }: { readonly onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const results = useMemo(() => searchDocsPages(DOCS_PAGES, DOCS_GROUPS, query), [query]);
  const active = Math.min(activeIndex, Math.max(results.length - 1, 0));

  useEffect(() => {
    const returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    inputRef.current?.focus();
    return () => returnTo?.focus({ preventScroll: true });
  }, []);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (results.length) setActiveIndex((active + (event.key === "ArrowDown" ? 1 : -1) + results.length) % results.length);
      return;
    }
    if (event.key === "Enter" && event.target === inputRef.current) {
      const page = results[active];
      if (!page) return;
      event.preventDefault();
      window.location.assign(page.href);
      return;
    }
    trapDialogFocus(event);
  }

  return (
    <div
      className="scrim"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="dlg sdlg" role="dialog" aria-modal="true" aria-label="Search docs" onKeyDown={onKeyDown}>
        <div className="sin">
          <Icon name="search" />
          <input
            ref={inputRef}
            value={query}
            placeholder="Search docs"
            role="combobox"
            aria-expanded="true"
            aria-controls="docs-search-results"
            aria-activedescendant={results.length ? `docs-search-result-${active}` : undefined}
            aria-autocomplete="list"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
          />
          <button type="button" className="ib" aria-label="Close search" onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>
        <div className="sres" id="docs-search-results" role="listbox" aria-label="Results">
          {results.length ? (
            <>
              {query.trim() ? null : (
                <p className="sgh" role="presentation">
                  Suggested
                </p>
              )}
              {results.map((page, index) => (
                <a key={page.slug} id={`docs-search-result-${index}`} className="sr1" href={page.href} role="option" aria-selected={index === active} tabIndex={-1} onMouseEnter={() => setActiveIndex(index)}>
                  <Icon name="file" />
                  <span>
                    <b>{highlight(page.navLabel, query)}</b>
                    <span>
                      {DOCS_GROUPS.find((group) => group.id === page.groupId)?.label} · {highlight(page.description, query)}
                    </span>
                  </span>
                </a>
              ))}
            </>
          ) : (
            <div className="sempty">
              <b>No results for “{query.trim()}”</b>
              <p>Try one word, like “recording” or “webhook”, or browse the menu.</p>
            </div>
          )}
        </div>
        <div className="sfoot" aria-hidden="true">
          <span>
            <span className="kbd">↑</span>
            <span className="kbd">↓</span>Move
          </span>
          <span>
            <span className="kbd">↵</span>Open
          </span>
          <span>
            <span className="kbd">esc</span>Close
          </span>
        </div>
      </div>
    </div>
  );
}
