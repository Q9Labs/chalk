// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Badge } from "./badge";

describe("Badge", () => {
  afterEach(cleanup);

  it("keeps a child and composes a separate count badge", () => {
    const { container } = render(<Badge count={3}>Messages</Badge>);

    expect(screen.getByText("Messages")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
    expect(container.querySelector(".absolute")).toBeTruthy();
  });

  it("keeps hook order stable when its count appears and disappears", () => {
    const view = render(<Badge>Messages</Badge>);

    view.rerender(<Badge count={3}>Messages</Badge>);
    expect(screen.getByText("Messages")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();

    view.rerender(<Badge>Messages</Badge>);
    expect(screen.getByText("Messages")).toBeTruthy();
    expect(screen.queryByText("3")).toBeNull();
  });
});
