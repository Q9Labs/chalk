import type * as React from "react";

type RenderableForwardRef = {
  render: (props: Record<string, unknown>, ref: null) => React.ReactElement;
};

export function renderForwardRef(component: unknown, props: Record<string, unknown> = {}) {
  return (component as RenderableForwardRef).render(props, null);
}
