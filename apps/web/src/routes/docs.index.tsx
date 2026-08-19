import { createFileRoute, notFound } from "@tanstack/react-router";

import { DocsArticle } from "../components/docs/DocsArticle";
import { docsNotFoundHead, docsPageHead } from "../docs/head";
import { findDocsPage } from "../docs/manifest";

export const Route = createFileRoute("/docs/")({
  loader: () => {
    const page = findDocsPage("");
    if (!page) throw notFound();
    return { page };
  },
  head: () => {
    const page = findDocsPage("");
    return page ? docsPageHead(page) : docsNotFoundHead();
  },
  component: DocsIndexRoute,
});

function DocsIndexRoute() {
  const { page } = Route.useLoaderData();
  return <DocsArticle page={page} />;
}
