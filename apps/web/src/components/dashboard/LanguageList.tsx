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

type SearchBoxProps = Pick<ListProps, "query" | "setQuery" | "rows" | "active" | "onKeyDown" | "search" | "listId">;

function SearchBox({ query, setQuery, rows, active, onKeyDown, search, listId }: SearchBoxProps) {
  return (
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
  );
}

type OptionProps = { readonly row: Row; readonly id: string; readonly query: string; readonly active: boolean; readonly selected: boolean; readonly onActive: () => void; readonly onChoose: () => void };

function LanguageOption({ row, id, query, active, selected, onActive, onChoose }: OptionProps) {
  const automatic = AUTOMATIC.find((item) => item.choice === row.choice);
  return (
    <div id={id} role="option" aria-selected={selected} className={`lp-opt${active ? " on" : ""}${selected ? " sel" : ""}`} onPointerMove={onActive} onClick={onChoose}>
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
}

function NoMatch({ query, search, setQuery, choose }: Pick<ListProps, "query" | "search" | "setQuery" | "choose">) {
  return (
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
  );
}

function statusText(query: string, count: number): string {
  if (!query.trim()) return "";
  if (!count) return "No languages match";
  return `${count} ${count === 1 ? "language" : "languages"}`;
}

/** The search box and the grouped language options inside the open popover or sheet. */
export function LanguageList({ query, setQuery, sections, rows, active, setActive, value, choose, onKeyDown, search, listId, statusId }: ListProps) {
  // Options are numbered across the groups, so each group starts after the rows before it.
  const firstIndex = sections.map((_, section) => sections.slice(0, section).reduce((sum, earlier) => sum + earlier.rows.length, 0));
  return (
    <>
      <SearchBox query={query} setQuery={setQuery} rows={rows} active={active} onKeyDown={onKeyDown} search={search} listId={listId} />
      <p className="lp-status" id={statusId} role="status">
        {statusText(query, rows.length)}
      </p>
      {rows.length ? (
        <div className="lp-list" role="listbox" id={listId} aria-label="Languages">
          {sections.map((section, sectionIndex) => (
            <div key={section.title ?? "rows"} role="group" aria-label={section.title ?? undefined}>
              {section.title ? (
                <div className="lp-head" aria-hidden="true">
                  {section.title}
                </div>
              ) : null}
              {section.rows.map((row, offset) => {
                const index = (firstIndex[sectionIndex] ?? 0) + offset;
                return <LanguageOption key={row.key} row={row} id={`${listId}-${index}`} query={query} active={index === active} selected={row.choice === value} onActive={() => setActive(index)} onChoose={() => choose(row.choice)} />;
              })}
            </div>
          ))}
        </div>
      ) : (
        <NoMatch query={query} search={search} setQuery={setQuery} choose={choose} />
      )}
    </>
  );
}
