/** @param {Record<string, any>} contract */
export function welcomeFlagsFor(contract) {
  return Object.values(contract.welcome)
    .filter((field) => field?.optional && field.value === true)
    .map((field) => field.wireName);
}
