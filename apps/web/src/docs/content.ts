import { lazy, type LazyExoticComponent } from "react";
import type { MDXContent } from "mdx/types";
import { slugOfFile } from "./slug.ts";

const loaders = import.meta.glob<{ default: MDXContent }>("./content/*.mdx");

/** The lazily loaded article for each docs slug, one per `content/*.mdx` file. */
export const DOCS_CONTENT: ReadonlyMap<string, LazyExoticComponent<MDXContent>> = new Map(Object.entries(loaders).map(([path, load]) => [slugOfFile(path.replace(/^.*\//, "").replace(/\.mdx$/, "")), lazy(load)]));

export function docsContent(slug: string): LazyExoticComponent<MDXContent> {
  const content = DOCS_CONTENT.get(slug);
  if (!content) throw new Error(`no docs article for slug "${slug}"`);
  return content;
}
