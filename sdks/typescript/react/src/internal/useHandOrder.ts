import { nextHandOrder } from "@q9labsai/chalk-client";
import { useMemo, useState } from "react";

/** Each raised hand's place in the queue, counting from 1, for the ids in `raised`. */
export function useHandOrder(raised: readonly string[]): ReadonlyMap<string, number> {
  const [order, setOrder] = useState<readonly string[]>([]);
  const next = nextHandOrder(order, raised);
  if (next !== order) setOrder(next);
  return useMemo(() => new Map(next.map((id, index) => [id, index + 1])), [next]);
}
