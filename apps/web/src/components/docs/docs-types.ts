import type { ReactNode } from "react";

export type DocsTone = "note" | "tip" | "caution" | "failure";

export type DocsCalloutProps = {
  children: ReactNode;
  title?: string;
  tone?: DocsTone;
};

export type DocsFeatureCardProps = {
  children: ReactNode;
  href: string;
  title: string;
};
