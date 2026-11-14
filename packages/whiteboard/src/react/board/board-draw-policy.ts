import type { DrawPerson, DrawPolicy } from "../../collab/draw-policy";

export type WhoCanDraw = {
  readonly policy: DrawPolicy;
  readonly people: readonly DrawPerson[];
  readonly onPolicy: (policy: DrawPolicy) => void;
  readonly onPick: (id: string, picked: boolean) => void;
};
