type OrderedElement = { readonly index: string | null; readonly id: string };

function compareCodeUnits(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

// Order keys compare as plain strings, code unit by code unit: "aZ" comes before "aa". A locale puts "aa" first.
// Two elements with the same key are ordered by id, the same way Sync and the Recording order them.
export function compareElementOrder(left: OrderedElement, right: OrderedElement): number {
  return compareCodeUnits(left.index ?? "", right.index ?? "") || compareCodeUnits(left.id, right.id);
}
