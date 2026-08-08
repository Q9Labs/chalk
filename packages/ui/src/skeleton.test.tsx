// @vitest-environment happy-dom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Skeleton } from "./skeleton";

describe("Skeleton", () => {
  afterEach(cleanup);

  it("stays out of the accessibility tree and defaults to full-width text shape", () => {
    const { container } = render(<Skeleton />);

    const skeleton = container.firstElementChild as HTMLElement;
    expect(skeleton.getAttribute("aria-hidden")).toBe("true");
    expect(skeleton.style.width).toBe("100%");
    expect(skeleton.style.height).toBe("1em");
  });

  it("applies explicit dimensions and the circular variant", () => {
    const { container } = render(<Skeleton variant="circular" width={40} height={40} animation="none" />);

    const skeleton = container.firstElementChild as HTMLElement;
    expect(skeleton.className).toContain("rounded-full");
    expect(skeleton.className).not.toContain("animate-pulse");
    expect(skeleton.style.width).toBe("40px");
    expect(skeleton.style.height).toBe("40px");
  });
});
