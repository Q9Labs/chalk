/** Longest joined argument text one command may carry. Windows stops a command line at 8191 characters. */
const maxCommandArgumentLength = 6000;

/** commandBatches splits a command whose last arguments are file paths into several commands that each fit one command line. `fixedCount` is how many leading entries (program and flags) every batch repeats. */
export function commandBatches(command, fixedCount, limit = maxCommandArgumentLength) {
  if (fixedCount >= command.length) return [command];
  const fixed = command.slice(0, fixedCount);
  const batches = [];
  let batch = [];
  let length = fixed.join(" ").length;
  for (const argument of command.slice(fixedCount)) {
    if (batch.length > 0 && length + argument.length + 1 > limit) {
      batches.push([...fixed, ...batch]);
      batch = [];
      length = fixed.join(" ").length;
    }
    batch.push(argument);
    length += argument.length + 1;
  }
  if (batch.length > 0) batches.push([...fixed, ...batch]);
  return batches;
}
