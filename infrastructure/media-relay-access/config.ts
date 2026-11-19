import { parseStage } from "../platform/stages.ts";

export const turnStage = (value: unknown) => {
  const stage = parseStage(value);
  if (stage.kind !== "production") throw new Error("Media relay access supports production only");
  return stage.name;
};
