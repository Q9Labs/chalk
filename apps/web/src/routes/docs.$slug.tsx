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
    <div className="art derr">
      <h1>Page not found</h1>
      <p>This docs page doesn’t exist. Start from Why Chalk, or pick a page from the menu.</p>
      <a className="btn pri" href="/docs">
        Back to Why Chalk
      </a>
    </div>
  );
}
