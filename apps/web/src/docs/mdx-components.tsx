import type { MDXComponents } from "mdx/types";

import { Callout, CardGrid, DocsLink, FeatureCard, InlineCode, CodeBlock } from "../components/docs/primitives";

export const MDX_COMPONENTS = {
  a: DocsLink,
  code: InlineCode,
  pre: CodeBlock,
  Callout,
  CardGrid,
  FeatureCard,
} satisfies MDXComponents;
