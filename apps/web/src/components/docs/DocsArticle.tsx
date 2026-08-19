import { Suspense, useEffect, useRef, useState } from "react";

import type { DocsPage } from "../../docs/manifest";
import { getAdjacentDocsPages } from "../../docs/manifest";
import { MDX_COMPONENTS } from "../../docs/mdx-components";

type DocsArticleProps = {
  page: DocsPage;
};

type OutlineItem = {
  id: string;
  label: string;
  level: 2 | 3;
};

export function DocsArticle({ page }: DocsArticleProps) {
  const articleRef = useRef<HTMLElement>(null);
  const [outline, setOutline] = useState<OutlineItem[]>([]);
  const { previous, next } = getAdjacentDocsPages(page.slug);

  useEffect(() => {
    const article = articleRef.current;
    if (!article) return;
    const updateOutline = () => {
      const headings = Array.from(article.querySelectorAll<HTMLHeadingElement>("h2[id], h3[id]"));
      setOutline(
        headings.flatMap((heading) => {
          const id = heading.id;
          const label = heading.textContent?.trim();
          if (!id || !label) return [];
          const level: OutlineItem["level"] = heading.tagName === "H3" ? 3 : 2;
          return [{ id, label, level }];
        }),
      );
    };

    updateOutline();
    const observer = new MutationObserver(updateOutline);
    observer.observe(article, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [page.slug]);

  return (
    <div className={page.layout === "landing" ? "docs-article-layout is-landing" : "docs-article-layout"}>
      <article ref={articleRef} className="docs-article" id="docs-content">
        <header className="docs-article-header">
          <p className="docs-article-group">{page.navLabel}</p>
          <h1>{page.title}</h1>
          <p className="docs-article-description">{page.description}</p>
          {page.layout === "landing" ? (
            <div className="docs-article-hero-actions">
              <a className="docs-article-primary-action" href="/docs/quickstart">
                Start with Quickstart <span aria-hidden="true">→</span>
              </a>
              <img src="/images/landing/chalk-flow-hero-20260818.webp" alt="" aria-hidden="true" width={1536} height={1024} />
            </div>
          ) : null}
        </header>
        <div className="docs-article-content">
          <Suspense
            fallback={
              <p className="docs-content-loading" role="status">
                Loading this page…
              </p>
            }
          >
            <page.Content components={MDX_COMPONENTS} />
          </Suspense>
        </div>
        <DocsPageNavigation previous={previous} next={next} />
      </article>
      <DocsOutline items={outline} />
    </div>
  );
}

function DocsOutline({ items }: { items: OutlineItem[] }) {
  if (!items.length) return null;
  return (
    <aside className="docs-outline" aria-label="On this page">
      <p>On this page</p>
      <nav>
        {items.map((item) => (
          <a key={item.id} className={item.level === 3 ? "is-subheading" : undefined} href={`#${item.id}`}>
            {item.label}
          </a>
        ))}
      </nav>
    </aside>
  );
}

function DocsPageNavigation({ next, previous }: { next: DocsPage | undefined; previous: DocsPage | undefined }) {
  if (!next && !previous) return null;
  return (
    <nav className="docs-page-navigation" aria-label="Page navigation">
      {previous ? (
        <a href={previous.href} className="docs-page-nav-link is-previous">
          <span>Previous</span>
          <strong>{previous.navLabel}</strong>
          <small aria-hidden="true">←</small>
        </a>
      ) : (
        <span />
      )}
      {next ? (
        <a href={next.href} className="docs-page-nav-link is-next">
          <span>Next</span>
          <strong>{next.navLabel}</strong>
          <small aria-hidden="true">→</small>
        </a>
      ) : (
        <span />
      )}
    </nav>
  );
}
