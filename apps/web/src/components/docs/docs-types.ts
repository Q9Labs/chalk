import type { ReactNode } from "react";

export type DocsTone = "note" | "tip" | "caution" | "failure";

export type DocsCalloutProps = {
  children: ReactNode;
  title?: string;
  tone?: DocsTone;
};

export type DocsFeatureCardProps = {
  children?: ReactNode;
  description?: string;
  eyebrow?: string;
  href?: string;
  icon?: ReactNode;
  title: string;
};
