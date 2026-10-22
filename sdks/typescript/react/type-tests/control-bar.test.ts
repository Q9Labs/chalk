import { expect, it } from "vitest";
import type { ClientFailure, MediaSource } from "@q9labsai/chalk-client";
import type { ControlBarProps } from "../src/index";

it("accepts an integrator’s original MediaSource handler in published ControlBarProps", () => {
  const oldStyleHandler: (failure: ClientFailure | null, source?: MediaSource) => void = () => undefined;
  const oldStyleProps: ControlBarProps = { onCommandError: oldStyleHandler };
  expect(oldStyleProps.onCommandError).toBe(oldStyleHandler);
});
