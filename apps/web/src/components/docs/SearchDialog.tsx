import Search01Icon from "@hugeicons/core-free-icons/Search01Icon";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useMemo, useRef, useState } from "react";

import { DOCS_GROUPS, DOCS_PAGES } from "../../docs/manifest";
import { trapDialogFocus } from "./dialog-focus";
import { searchDocsPages } from "./search";

type SearchDialogProps = {
  onClose: () => void;
  open: boolean;
};

export function SearchDialog({ onClose, open }: SearchDialogProps) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const results = useMemo(() => searchDocsPages(DOCS_PAGES, DOCS_GROUPS, query), [query]);
  const hasResults = results.length > 0;

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setQuery("");
    setActiveIndex(0);
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      if (previousFocusRef.current?.isConnected) previousFocusRef.current.focus({ preventScroll: true });
    };
  }, [open]);

  useEffect(() => {
    if (activeIndex >= results.length) setActiveIndex(Math.max(0, results.length - 1));
  }, [activeIndex, results.length]);

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (hasResults) setActiveIndex((index) => (index + 1) % results.length);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (hasResults) setActiveIndex((index) => (index - 1 + results.length) % results.length);
      return;
    }
    if (event.key === "Enter" && hasResults) {
      event.preventDefault();
      const page = results[activeIndex];
      if (page) window.location.href = page.href;
    }
  }

  if (!open) return null;

  return (
    <div
      className="docs-search-layer"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section className="docs-search-dialog" role="dialog" aria-modal="true" aria-labelledby="docs-search-title" onKeyDown={trapDialogFocus}>
        <div className="docs-search-heading">
          <div>
            <p className="docs-search-kicker">Chalk docs</p>
            <h2 id="docs-search-title">Search documentation</h2>
          </div>
          <button type="button" className="docs-search-close" onClick={onClose}>
            <span className="visually-hidden">Close search</span>
            <span aria-hidden="true">Esc</span>
          </button>
        </div>
        <label className="docs-search-field">
          <span className="visually-hidden">Search documentation</span>
          <HugeiconsIcon icon={Search01Icon} size={19} strokeWidth={1.8} aria-hidden="true" focusable="false" />
          <input
            ref={inputRef}
            type="search"
            value={query}
            placeholder="Search pages, concepts, and APIs"
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={handleKeyDown}
            aria-controls="docs-search-results"
            aria-activedescendant={hasResults ? `docs-search-result-${activeIndex}` : undefined}
            aria-autocomplete="list"
            aria-expanded="true"
            role="combobox"
          />
          <kbd>⌘K</kbd>
        </label>
        <div id="docs-search-results" className="docs-search-results" role="listbox" aria-label="Documentation results">
          {hasResults ? (
            results.map((page, index) => (
              <a id={`docs-search-result-${index}`} key={page.slug} className="docs-search-result" href={page.href} role="option" aria-selected={index === activeIndex} onMouseEnter={() => setActiveIndex(index)} onClick={onClose}>
                <span className="docs-search-result-group">{DOCS_GROUPS.find((group) => group.id === page.groupId)?.label ?? "Docs"}</span>
                <strong>{page.navLabel}</strong>
                <span>{page.description}</span>
              </a>
            ))
          ) : (
            <p className="docs-search-empty">No pages match “{query}”. Try a broader term.</p>
          )}
        </div>
        <p className="docs-search-help">Use ↑ ↓ to move, Enter to open, and Esc to close.</p>
      </section>
    </div>
  );
}
