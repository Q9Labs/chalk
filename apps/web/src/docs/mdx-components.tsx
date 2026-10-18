import type { MDXComponents } from "mdx/types";

import { Callout, CardGrid, CodeBlock, DocsLink, FeatureCard } from "../components/docs/primitives";

export const MDX_COMPONENTS = {
  a: DocsLink,
  pre: CodeBlock,
  Callout,
  CardGrid,
  FeatureCard,
} satisfies MDXComponents;
