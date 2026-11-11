/** Answers every request, so one failure leaves the others answered. Throws "2 of 3 let in" when some fail. */
export async function answerAll(ids: readonly string[], answer: (id: string) => Promise<unknown>, outcome: "let in" | "declined"): Promise<void> {
  const results = await Promise.allSettled(ids.map((id) => answer(id)));
  const done = results.filter((result) => result.status === "fulfilled").length;
  if (done < ids.length) throw new Error(`${done} of ${ids.length} ${outcome}`);
}
