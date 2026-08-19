import { createFileRoute, notFound } from "@tanstack/react-router";

import { DocsArticle } from "../components/docs/DocsArticle";
import { docsNotFoundHead, docsPageHead } from "../docs/head";
import { findDocsPage } from "../docs/manifest";

export const Route = createFileRoute("/docs/$slug")({
  loader: ({ params }) => {
    const page = findDocsPage(params.slug);
    if (!page) throw notFound();
    return { page };
  },
  head: ({ params }) => {
    const page = findDocsPage(params.slug);
    return page ? docsPageHead(page) : docsNotFoundHead();
  },
  notFoundComponent: DocsNotFound,
  component: DocsSlugRoute,
});

function DocsSlugRoute() {
  const { page } = Route.useLoaderData();
  return <DocsArticle page={page} />;
}

function DocsNotFound() {
  return (
    <div className="docs-article-layout">
      <article className="docs-article docs-not-found" id="docs-content">
        <p className="docs-article-group">Chalk docs</p>
        <h1>Page not found</h1>
        <p>The docs page you requested does not exist. Start from Why Chalk or open the Quickstart.</p>
        <nav className="docs-not-found-links" aria-label="Not found navigation">
          <a className="docs-article-primary-action" href="/docs">
            Back to Why Chalk <span aria-hidden="true">→</span>
          </a>
          <a href="/docs/quickstart">Open Quickstart</a>
        </nav>
      </article>
    </div>
  );
}
