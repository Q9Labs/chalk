// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { useLoad } from "./AppShell";

const router = vi.hoisted(() => ({ state: { location: { pathname: "/dashboard/developer" } } }));
vi.mock("@tanstack/react-router", () => ({ useRouter: () => router }));

afterEach(cleanup);

it("does not bring stale data back over a failed reload when an earlier action finishes", async () => {
  let fail = false;
  async function load() {
    if (fail) throw new Error("Network unavailable");
    return "Original deliveries";
  }
  function Deliveries() {
    const { state, reload, update } = useLoad(load, "deliveries");
    return (
      <>
        <output>{state.kind === "ready" ? state.data : state.kind}</output>
        <button onClick={reload}>Reload</button>
        <button onClick={() => update(() => "Stale deliveries")}>Finish earlier action</button>
      </>
    );
  }
  await act(async () => {
    render(<Deliveries />);
  });
  expect(screen.getByText("Original deliveries")).toBeTruthy();
  fail = true;
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
  });
  expect(screen.getByText("error")).toBeTruthy();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Finish earlier action" }));
  });
  expect(screen.getByText("error")).toBeTruthy();
  expect(screen.queryByText("Stale deliveries")).toBeNull();
});
