import type { MDXComponents } from "mdx/types";

import { Callout, CardGrid, Chips, CodeBlock, DocsLink, FeatureCard } from "../components/docs/primitives";

export const MDX_COMPONENTS = {
  a: DocsLink,
  pre: CodeBlock,
  Callout,
  CardGrid,
  Chips,
  FeatureCard,
} satisfies MDXComponents;
