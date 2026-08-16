// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ChalkProvider } from "../../bindings/context";
import { createSnapshot, createTestClient } from "../../test-support/test-client";
import { ScreenShareView } from "./ScreenShareView";

afterEach(cleanup);

describe("ScreenShareView", () => {
  it("uses the chalk empty state when no share is active", () => {
    const client = createTestClient(createSnapshot());

    render(
      <ChalkProvider client={client}>
        <ScreenShareView />
      </ChalkProvider>,
    );

    expect(screen.getByRole("status")).toHaveTextContent("No active screen share");
    expect(document.querySelector('svg[data-chalk-chrome="true"]')).toBeInTheDocument();
  });
});
