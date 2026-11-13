import type { MobileSpaceArrival, SpaceRoute } from "./spaces";

export type ArrivedCall = {
  readonly route: SpaceRoute;
  readonly arrival: MobileSpaceArrival;
  /** True when this person just started the call, so the app offers its link. */
  readonly started: boolean;
};
