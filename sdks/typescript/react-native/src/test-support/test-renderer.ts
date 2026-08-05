import { createRequire } from "node:module";
import { join } from "node:path";
import type { ComponentType, ReactNode } from "react";

type RenderHookOptions<Props> = {
  readonly initialProps?: Props;
  readonly wrapper?: ComponentType<{ readonly children?: ReactNode }>;
};

type RenderHookResult<Result, Props> = {
  readonly result: { readonly current: Result };
  readonly rerender: (props?: Props) => void;
  readonly unmount: () => void;
};

type RenderHook = <Result, Props = undefined>(callback: (props: Props) => Result, options?: RenderHookOptions<Props>) => RenderHookResult<Result, Props>;
type Act = (callback: () => void | Promise<void>) => void | Promise<void>;
type WaitFor = (callback: () => void | Promise<void>) => Promise<void>;

const testingLibrary = createRequire(import.meta.url)(join(process.cwd(), "../react/node_modules", "@" + "testing-library", "react")) as {
  readonly act: Act;
  readonly renderHook: RenderHook;
  readonly waitFor: WaitFor;
};

export const { act, renderHook, waitFor } = testingLibrary;
