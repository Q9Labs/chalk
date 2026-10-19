import { GitHubMark } from "../site/GitHubMark";
import { Icon } from "../site/Icon";
import { GITHUB_URL, SIGN_IN_HREF } from "../site/links";
import { Lockup } from "../site/Lockup";
import { ThemeButton } from "../site/theme";

export function DocsHeader({ onSearchOpen }: { readonly onSearchOpen: () => void }) {
  return (
    <header className="dhead">
      <a href="/" aria-label="Chalk home">
        <Lockup />
      </a>
      <span className="dsep" aria-hidden="true" />
      <a className="dlab" href="/docs">
        Docs
      </a>
      <button type="button" className="dsearch" aria-keyshortcuts="Meta+K" onClick={onSearchOpen}>
        <Icon name="search" />
        Search docs
        <span className="kbd" aria-hidden="true">
          ⌘K
        </span>
      </button>
      <div className="dr">
        <button type="button" className="ib dsearch-icon" aria-label="Search docs" onClick={onSearchOpen}>
          <Icon name="search" />
        </button>
        <a className="ghl" href={GITHUB_URL}>
          <GitHubMark />
          GitHub
        </a>
        <ThemeButton />
        <a className="btn gh dsignin" href={SIGN_IN_HREF}>
          Sign in
        </a>
      </div>
    </header>
  );
}
