// Several jobs of one run each own a section of a pull request's single scorecard comment.
export const MARKER = "<!-- chalk-scorecard -->";
const END = "<!-- /section -->";

/** upsertSection returns the comment body with `section` replaced by `markdown`, or added when the body lacks it. */
export function upsertSection(body, section, markdown) {
  const open = `<!-- section:${section} -->`;
  const kept = (body ?? "")
    .slice(MARKER.length)
    .split(END)
    .map((part) => part.trim())
    .filter((part) => part !== "" && !part.startsWith(open));
  return [MARKER, ...kept.map((part) => `${part}\n${END}`), `${open}\n${markdown.trim()}\n${END}`].join("\n");
}
