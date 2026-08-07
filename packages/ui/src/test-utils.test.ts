import { describe, expect, it } from "vitest";
import { renderForwardRef } from "./test-utils";

describe("renderForwardRef", () => {
  it("passes props and the null ref to a forward-ref render function", () => {
    const component = {
      render: (props: Record<string, unknown>, ref: null) => ({ props, ref }) as never,
    };
    const props = { "data-test": "helper", children: "content" };

    expect(renderForwardRef(component, props)).toEqual({ props, ref: null });
  });

  it("uses an empty props object when callers omit props", () => {
    const component = {
      render: (props: Record<string, unknown>, ref: null) => ({ props, ref }) as never,
    };

    expect(renderForwardRef(component)).toEqual({ props: {}, ref: null });
  });
});
