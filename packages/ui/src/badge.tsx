import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import type React from "react";

import { cn } from "./lib/utils";

const badgeVariants = cva(
  "h-5 gap-1 rounded-full border border-transparent px-2 py-0.5 text-xs font-medium transition-colors has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&>svg]:size-3! inline-flex items-center justify-center w-fit whitespace-nowrap shrink-0 [&>svg]:pointer-events-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[2px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive overflow-hidden group/badge",
  {
    variants: {
      variant: {
        default: "bg-accent text-accent-foreground [a]:hover:bg-accent/80",
        secondary: "bg-secondary text-secondary-foreground [a]:hover:bg-secondary/80",
        destructive: "bg-destructive/10 [a]:hover:bg-destructive/20 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 text-destructive dark:bg-destructive/20",
        outline: "border-border text-foreground [a]:hover:bg-muted [a]:hover:text-muted-foreground",
        ghost: "hover:bg-muted hover:text-muted-foreground dark:hover:bg-muted/50",
        link: "text-primary underline-offset-4 hover:underline",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

type BadgeProps = useRender.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & {
    readonly count?: number;
    readonly max?: number;
    readonly dot?: boolean;
    readonly showZero?: boolean;
  };

function getBadgeContent(count: number | undefined, max: number, dot: boolean): React.ReactNode {
  if (dot) return null;
  if (count !== undefined && count > max) return `${max}+`;
  return count;
}

function CountBadge({ className, variant, dot, content }: { readonly className?: string; readonly variant: BadgeProps["variant"]; readonly dot: boolean; readonly content: React.ReactNode }) {
  return <span className={cn(badgeVariants({ className, variant }), dot ? "h-2 w-2 p-0" : "min-w-5 px-2", "absolute -top-1 -right-1 translate-x-1/2 -translate-y-1/2 z-10")}>{content}</span>;
}

function Badge({ className, variant = "default", render, count, max = 99, dot = false, showZero = false, children, ...props }: BadgeProps) {
  const hasCount = count !== undefined || dot;
  const renderedPlain = useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(
      {
        className: cn(badgeVariants({ className, variant })),
      },
      { ...props, children },
    ),
    render,
    state: {
      slot: "badge",
      variant,
    },
  });

  if (!hasCount) {
    return renderedPlain;
  }

  if (!showZero && count === 0 && !dot) return <>{children}</>;
  const content = getBadgeContent(count, max, dot);
  if (children) {
    return (
      <span className="relative inline-flex overflow-visible" {...props}>
        {children}
        <CountBadge className={className} variant={variant} dot={dot} content={content} />
      </span>
    );
  }

  return (
    <span className={cn(badgeVariants({ className, variant }), dot ? "h-2 w-2 p-0" : "min-w-5 px-2")} {...props}>
      {content}
    </span>
  );
}

export { Badge, badgeVariants };
