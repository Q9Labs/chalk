// @ts-check
/**
 * `--json`: the same view the text renders, as one compact line. It carries `v: 1`; a key whose value is null is left out, so a
 * missing key reads as null. Arrays are always present, so an empty list of gaps is a claim, not an omission.
 */

/** @typedef {import("./views.mjs").View} View */

/** @param {View} view */
export const renderJson = (view) => `${JSON.stringify(view, (_key, value) => (value === null ? undefined : value))}\n`;
