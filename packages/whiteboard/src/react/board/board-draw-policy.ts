export type WhoCanDraw = {
  readonly policy: "everyone" | "hosts" | "picked";
  readonly people: readonly { readonly id: string; readonly name: string; readonly picked: boolean }[];
  readonly onPolicy: (policy: WhoCanDraw["policy"]) => void;
  readonly onPick: (id: string, picked: boolean) => void;
};
