// @vitest-environment happy-dom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ControlBar } from "./ControlBar";

afterEach(cleanup);

describe("ControlBar palette surfaces", () => {
  it("uses app control tokens for compact media controls", () => {
    const { container } = render(<ControlBar placement="floating" density="compact" buttons={["mic", "leave"]} />);

    expect(container.querySelector('[class*="chalk-app-control-primary"]')).toBeInTheDocument();
    expect(container.querySelector('[class*="chalk-app-danger"]')).toBeInTheDocument();
  });
});
