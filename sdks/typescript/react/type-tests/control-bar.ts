import type { ClientFailure, MediaSource } from "@q9labsai/chalk-client";
import type { ControlBarProps } from "../src/index";

declare const oldStyleHandler: (failure: ClientFailure | null, source?: MediaSource) => void;
export const oldStyleProps: ControlBarProps = { onCommandError: oldStyleHandler };
