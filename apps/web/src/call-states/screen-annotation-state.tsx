import { lazy, Suspense } from "react";
import type { CallState } from "./states";

const ScreenAnnotationFixture = lazy(() => import("./screen-annotation").then((module) => ({ default: module.ScreenAnnotationFixture })));

export const SCREEN_ANNOTATION_STATE: CallState = {
  id: "screen-annotation",
  title: "Screen annotation",
  render: () => (
    <Suspense fallback={null}>
      <ScreenAnnotationFixture />
    </Suspense>
  ),
};
