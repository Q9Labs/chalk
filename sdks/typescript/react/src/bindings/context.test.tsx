// @vitest-environment happy-dom

import type { SpaceClient } from "@q9labsai/chalk-client";
import { cleanup, render, screen } from "@testing-library/react";
import { useContext } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { ChalkProvider, SpaceClientContext } from "./context";

afterEach(cleanup);

describe("ChalkProvider", () => {
  it("provides the supplied SpaceClient to descendants", () => {
    const client = {} as SpaceClient;

    function ClientMarker() {
      const providedClient = useContext(SpaceClientContext);
      return <output data-testid="client-state">{providedClient === client ? "provided" : "missing"}</output>;
    }

    render(
      <ChalkProvider client={client}>
        <ClientMarker />
      </ChalkProvider>,
    );

    expect(screen.getByTestId("client-state")).toHaveTextContent("provided");
  });

  it("updates the context when the supplied client changes", () => {
    const firstClient = {} as SpaceClient;
    const secondClient = {} as SpaceClient;

    function ClientMarker() {
      const providedClient = useContext(SpaceClientContext);
      return <output data-testid="client-state">{providedClient === secondClient ? "second" : "first"}</output>;
    }

    const view = render(
      <ChalkProvider client={firstClient}>
        <ClientMarker />
      </ChalkProvider>,
    );

    expect(screen.getByTestId("client-state")).toHaveTextContent("first");

    view.rerender(
      <ChalkProvider client={secondClient}>
        <ClientMarker />
      </ChalkProvider>,
    );

    expect(screen.getByTestId("client-state")).toHaveTextContent("second");
  });
});
