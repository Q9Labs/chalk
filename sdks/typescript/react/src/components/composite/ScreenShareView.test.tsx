// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ChalkProvider } from "../../bindings/context";
import { SkinProvider } from "../skin-context";
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

  it("restores the classic empty state without rough chrome", () => {
    render(
      <SkinProvider skin="classic">
        <ChalkProvider client={createTestClient(createSnapshot())}>
          <ScreenShareView />
        </ChalkProvider>
      </SkinProvider>,
    );

    const emptyState = screen.getByRole("status");
    expect(emptyState).toHaveClass("text-sm", "text-[var(--chalk-app-text-muted)]");
    expect(emptyState.querySelector("svg[data-chalk-chrome='true']")).not.toBeInTheDocument();
  });
});
