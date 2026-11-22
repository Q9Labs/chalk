import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";

import { Icon } from "../site/Icon";
import { trapDialogFocus } from "../../lib/dialog-focus";
import { searchDocs } from "./search";

function highlight(text: string, query: string): ReactNode {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return text;
  const pattern = new RegExp(`(${words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  return text.split(pattern).map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : part));
}

type Results = ReturnType<typeof searchDocs>;

function SearchResults({ results, query, active, onHover, onClose }: { readonly results: Results; readonly query: string; readonly active: number; readonly onHover: (index: number) => void; readonly onClose: () => void }) {
  return (
    <div className="sres" id="docs-search-results" role="listbox" aria-label="Results">
      {results.length ? (
        <>
          {query.trim() ? null : (
            <p className="sgh" role="presentation">
              Suggested
            </p>
          )}
          {results.map((result, index) => (
            <a key={result.href} id={`docs-search-result-${index}`} className="sr1" href={result.href} role="option" aria-selected={index === active} tabIndex={-1} onMouseEnter={() => onHover(index)} onClick={onClose}>
              <Icon name="file" />
              <span>
                <b>{highlight(result.title, query)}</b>
                <span>
                  {result.context} · {highlight(result.excerpt, query)}
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
  );
}

function SearchFooter() {
  return (
    <div className="sfoot" aria-hidden="true">
      <span>
        <span className="kbd">↑</span>
        <span className="kbd">↓</span>Move
      </span>
      <span>
        <span className="kbd">↵</span>Open
      </span>
      <span>
        <span className="kbd" data-word>
          esc
        </span>
        Close
      </span>
    </div>
  );
}

function SearchInput({ inputRef, query, activeId, onQuery, onClose }: { readonly inputRef: RefObject<HTMLInputElement | null>; readonly query: string; readonly activeId: string | undefined; readonly onQuery: (query: string) => void; readonly onClose: () => void }) {
  return (
    <div className="sin">
      <Icon name="search" />
      <input ref={inputRef} value={query} placeholder="Search docs" role="combobox" aria-expanded="true" aria-controls="docs-search-results" aria-activedescendant={activeId} aria-autocomplete="list" autoComplete="off" spellCheck={false} onChange={(event) => onQuery(event.target.value)} />
      <button type="button" className="ib" aria-label="Close search" onClick={onClose}>
        <Icon name="x" />
      </button>
    </div>
  );
}

export function SearchDialog({ onClose }: { readonly onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const results = useMemo(() => searchDocs(query), [query]);
  const active = Math.min(activeIndex, Math.max(results.length - 1, 0));

  useEffect(() => {
    const returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    inputRef.current?.focus();
    return () => returnTo?.focus({ preventScroll: true });
  }, []);

  function onQuery(next: string) {
    setQuery(next);
    setActiveIndex(0);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const move = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    } else if (move) {
      event.preventDefault();
      if (results.length) setActiveIndex((active + move + results.length) % results.length);
    } else if (event.key === "Enter" && event.target === inputRef.current) {
      openResult(results[active], event);
    } else {
      trapDialogFocus(event);
    }
  }

  function openResult(result: Results[number] | undefined, event: KeyboardEvent<HTMLDivElement>) {
    if (!result) return;
    event.preventDefault();
    onClose();
    window.location.assign(result.href);
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
        <SearchInput inputRef={inputRef} query={query} activeId={results.length ? `docs-search-result-${active}` : undefined} onQuery={onQuery} onClose={onClose} />
        <SearchResults results={results} query={query} active={active} onHover={setActiveIndex} onClose={onClose} />
        <SearchFooter />
      </div>
    </div>
  );
}
