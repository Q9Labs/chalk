import { type KeyboardEvent, type RefObject } from "react";
import { whisperLanguageCodes } from "@chalk/transcript-language";
import { Icon } from "../site/Icon";
import { AUTOMATIC, Flag, Glyph, Mark, rowTitle, type Choice, type Row, type Section } from "./language-rows";

type ListProps = {
  readonly query: string;
  readonly setQuery: (query: string) => void;
  readonly sections: readonly Section[];
  readonly rows: readonly Row[];
  readonly active: number;
  readonly setActive: (index: number) => void;
  readonly value: Choice;
  readonly choose: (choice: Choice) => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  readonly search: RefObject<HTMLInputElement | null>;
  readonly listId: string;
  readonly statusId: string;
};

/** The search box and the grouped language options inside the open popover or sheet. */
export function LanguageList({ query, setQuery, sections, rows, active, setActive, value, choose, onKeyDown, search, listId, statusId }: ListProps) {
  let at = -1;
  return (
    <>
      <div className="lp-search">
        <Icon name="search" size={18} />
        <input
          ref={search}
          type="search"
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={rows.length ? `${listId}-${active}` : undefined}
          aria-autocomplete="list"
          aria-label="Search languages"
          placeholder="Search by name, native name or code"
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
        />
        {!query ? <kbd aria-hidden="true">Esc</kbd> : null}
        {query && rows.length ? (
          <button
            type="button"
            className="ib"
            aria-label="Clear search"
            onClick={() => {
              setQuery("");
              search.current?.focus();
            }}
          >
            <Icon name="x" size={16} />
          </button>
        ) : null}
      </div>
      <p className="lp-status" id={statusId} role="status">
        {query.trim() ? (rows.length ? `${rows.length} ${rows.length === 1 ? "language" : "languages"}` : "No languages match") : ""}
      </p>
      {rows.length ? (
        <div className="lp-list" role="listbox" id={listId} aria-label="Languages">
          {sections.map((section) => (
            <div key={section.title ?? "rows"} role="group" aria-label={section.title ?? undefined}>
              {section.title ? (
                <div className="lp-head" aria-hidden="true">
                  {section.title}
                </div>
              ) : null}
              {section.rows.map((row) => {
                at += 1;
                const index = at;
                const selected = row.choice === value;
                const automatic = AUTOMATIC.find((item) => item.choice === row.choice);
                return (
                  <div key={row.key} id={`${listId}-${index}`} role="option" aria-selected={selected} className={`lp-opt${index === active ? " on" : ""}${selected ? " sel" : ""}`} onPointerMove={() => setActive(index)} onClick={() => choose(row.choice)}>
                    {row.option ? <Flag option={row.option} /> : <Glyph icon={automatic?.icon ?? "globe"} />}
                    <span className="lp-text">
                      <span className="lp-name">{row.option ? <Mark text={row.option.name} query={query} /> : rowTitle(row)}</span>
                      {row.note ? <small>{row.note}</small> : null}
                    </span>
                    {row.option?.native ? (
                      <span className="lp-native" lang={row.option.code} dir="auto">
                        <Mark text={row.option.native} query={query} />
                      </span>
                    ) : null}
                    {selected ? <Icon name="check" size={16} className="lp-check" /> : null}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      ) : (
        <div className="lp-none">
          <b>No language matches “{query.trim()}”</b>
          <p>Chalk lists the {whisperLanguageCodes.length} languages its transcriber supports. Check the spelling, or search by the language’s own name or code.</p>
          <div className="lp-acts">
            <button
              type="button"
              className="btn pri sm"
              onClick={() => {
                setQuery("");
                search.current?.focus();
              }}
            >
              Clear search
            </button>
            <button type="button" className="btn sm" onClick={() => choose("auto")}>
              Use Auto-detect
            </button>
          </div>
        </div>
      )}
    </>
  );
}
