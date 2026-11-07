// Each job of a run owns one sticky pull request comment, found by its section marker. Two jobs never write the same comment,
// so they cannot overwrite each other.

/** sectionComment returns the comment body for one section: its marker, then the table. */
export function sectionComment(section, markdown) {
  return `${sectionMarker(section)}\n${markdown.trim()}\n`;
}

/** sectionMarker is the first line of a section's comment. */
export function sectionMarker(section) {
  return `<!-- chalk-scorecard:${section} -->`;
}
