// @ts-check
// A card from a plane that is not measured under chalk_sfu's conditions says so wherever the card is shown.

/** @type {Readonly<Record<string, string>>} */
const NOTES = {
  cf_sfu:
    "This Cloudflare card is measured from a GitHub-hosted runner in Iowa. There Cloudflare media goes to a nearby point of presence, while chalk_sfu media goes to Singapore, so the two planes are not a fair comparison yet. Cloudflare also runs with fewer samples than chalk_sfu; read n on each row.",
};

/** @param {string} plane */
export function planeNoteMarkdown(plane) {
  const note = NOTES[plane];
  return note ? `> **Read with care:** ${note}\n\n` : "";
}
