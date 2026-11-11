import { expect, it } from "vitest";
import { answerAll } from "./answer-all";

it("answers every request even when one fails, and reports how many went through", async () => {
  const answered: string[] = [];
  const answer = async (id: string) => {
    if (id === "b") throw new Error("gone");
    answered.push(id);
  };
  await expect(answerAll(["a", "b", "c"], answer, "let in")).rejects.toThrow("2 of 3 let in");
  expect(answered).toEqual(["a", "c"]);
});

it("resolves when everyone is answered", async () => {
  await expect(answerAll(["a", "b"], async () => undefined, "declined")).resolves.toBeUndefined();
});
