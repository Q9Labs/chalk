import type { MobileSpaceArrival } from "./spaces";
import type { SpaceRoute } from "./space-link";

export type ArrivedCall = {
  readonly route: SpaceRoute;
  readonly arrival: MobileSpaceArrival;
  /** True when this person just started the call, so the app offers its link. */
  readonly started: boolean;
};
