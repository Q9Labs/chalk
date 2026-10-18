import { Suspense, useEffect, useRef, useState } from "react";

import type { DocsPage } from "../../docs/manifest";
import { getAdjacentDocsPages } from "../../docs/manifest";
import { MDX_COMPONENTS } from "../../docs/mdx-components";
import { Icon } from "../site/Icon";
import { GITHUB_URL } from "../site/links";

type OutlineItem = { readonly id: string; readonly label: string; readonly level: 2 | 3 };

/** How far below the top bar a heading counts as the one being read. */
const READING_LINE = 96;

/** A malformed escape in a shared link leaves the page where it is instead of breaking it. */
function readHashId(): string {
  const hash = window.location.hash.slice(1);
  try {
    return decodeURIComponent(hash);
  } catch {
    return hash;
  }
}

export function DocsArticle({ page }: { readonly page: DocsPage }) {
  const articleRef = useRef<HTMLElement>(null);
  const [outline, setOutline] = useState<readonly OutlineItem[]>([]);
  const [currentId, setCurrentId] = useState<string>();
  const { previous, next } = getAdjacentDocsPages(page.slug);

  useEffect(() => {
    const article = articleRef.current;
    if (!article) return;
    const headings = () => Array.from(article.querySelectorAll<HTMLHeadingElement>(".art-body h2[id], .art-body h3[id]"));
    // The page content loads after the browser's own jump to the URL hash, so the article makes that jump once it arrives.
    let pendingHash = readHashId();
    const readOutline = () => {
      setOutline(
        headings().flatMap((heading) => {
          const label = heading.textContent?.trim();
          return label ? [{ id: heading.id, label, level: heading.tagName === "H3" ? 3 : 2 }] : [];
        }),
      );
      const target = pendingHash ? document.getElementById(pendingHash) : null;
      if (!target) return;
      pendingHash = "";
      target.scrollIntoView();
    };
    let frame = 0;
    const readPosition = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const all = headings();
        const atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
        const passed = all.filter((heading) => heading.getBoundingClientRect().top < READING_LINE);
        // At the bottom of the page the last sections can't reach the reading line, so the outline marks the last one.
        setCurrentId((atBottom && window.scrollY > 0 ? all : passed).at(-1)?.id);
      });
    };
    readOutline();
    readPosition();
    const observer = new MutationObserver(readOutline);
    observer.observe(article, { childList: true, subtree: true });
    window.addEventListener("scroll", readPosition, { passive: true });
    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", readPosition);
      cancelAnimationFrame(frame);
    };
  }, [page.slug]);

  const current = currentId ?? outline[0]?.id;
  return (
    <div className="dpage">
      <article ref={articleRef} className="art" id="docs-content">
        <h1>{page.title}</h1>
        <p className="desc">{page.description}</p>
        {outline.length ? (
          <details className="otp">
            <summary>
              On this page
              <Icon name="down" />
            </summary>
            {outline.map((item) => (
              <a key={item.id} href={`#${item.id}`}>
                {item.label}
              </a>
            ))}
          </details>
        ) : null}
        <div className="art-body">
          <Suspense
            fallback={
              <p className="mu" role="status">
                Loading this page…
              </p>
            }
          >
            <page.Content components={MDX_COMPONENTS} />
          </Suspense>
        </div>
        {previous || next ? (
          <nav className="pn" aria-label="Previous and next">
            {previous ? (
              <a href={previous.href}>
                <small>
                  <Icon name="left" />
                  Previous
                </small>
                <b>{previous.navLabel}</b>
              </a>
            ) : null}
            {next ? (
              <a className="nx" href={next.href}>
                <small>
                  Next
                  <Icon name="right" />
                </small>
                <b>{next.navLabel}</b>
              </a>
            ) : null}
          </nav>
        ) : null}
        <div className="dfoot">
          <a href={`${GITHUB_URL}/edit/master/apps/web/src/docs/content/${page.slug || "why-chalk"}.mdx`}>
            <Icon name="edit" />
            Edit this page on GitHub
          </a>
        </div>
      </article>
      {outline.length ? (
        <nav className="toc" aria-label="On this page">
          <h3>On this page</h3>
          {outline.map((item) => (
            <a key={item.id} href={`#${item.id}`} className={[item.id === current ? "on" : "", item.level === 3 ? "tsub" : ""].join(" ").trim() || undefined} aria-current={item.id === current ? "location" : undefined}>
              {item.label}
            </a>
          ))}
        </nav>
      ) : null}
    </div>
  );
}
