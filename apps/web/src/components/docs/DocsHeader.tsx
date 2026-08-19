import ArrowRight02Icon from "@hugeicons/core-free-icons/ArrowRight02Icon";
import Menu01Icon from "@hugeicons/core-free-icons/Menu01Icon";
import Search01Icon from "@hugeicons/core-free-icons/Search01Icon";
import { HugeiconsIcon } from "@hugeicons/react";
import type { RefObject } from "react";

type DocsHeaderProps = {
  mobileNavOpen: boolean;
  menuButtonRef: RefObject<HTMLButtonElement | null>;
  onMenuToggle: () => void;
  onSearchOpen: () => void;
};

export function DocsHeader({ menuButtonRef, mobileNavOpen, onMenuToggle, onSearchOpen }: DocsHeaderProps) {
  return (
    <header className="docs-header">
      <div className="docs-header-inner">
        <a href="/" className="docs-logo" aria-label="Chalk home">
          <img src="/brand/chalk/chalk-logo.svg" alt="Chalk" />
          <span>Docs</span>
        </a>
        <nav className="docs-header-nav" aria-label="Documentation header">
          <a href="/">Product</a>
          <a href="/sign-in">Sign in</a>
          <a className="docs-header-cta" href="/sign-up">
            Create an account
            <HugeiconsIcon icon={ArrowRight02Icon} size={15} strokeWidth={2} aria-hidden="true" focusable="false" />
          </a>
        </nav>
        <div className="docs-header-actions">
          <button type="button" className="docs-search-trigger" aria-label="Search docs" onClick={onSearchOpen}>
            <HugeiconsIcon icon={Search01Icon} size={18} strokeWidth={1.8} aria-hidden="true" focusable="false" />
            <span>Search docs</span>
            <kbd>⌘K</kbd>
          </button>
          <button ref={menuButtonRef} type="button" className="docs-menu-trigger" aria-expanded={mobileNavOpen} aria-controls="docs-mobile-navigation" onClick={onMenuToggle}>
            <HugeiconsIcon icon={Menu01Icon} size={20} strokeWidth={1.8} aria-hidden="true" focusable="false" />
            <span className="visually-hidden">{mobileNavOpen ? "Close navigation" : "Open navigation"}</span>
          </button>
        </div>
      </div>
    </header>
  );
}
