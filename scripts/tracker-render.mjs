import { groupOutcomes } from "./tracker-data.mjs";

const stateLabels = {
  planned: "Not started",
  in_progress: "Partly working",
  blocked: "Blocked",
  unknown: "Unclear",
};

const numberedGroups = (tracker) => {
  let number = 0;
  return groupOutcomes(tracker).map((group) => ({ ...group, items: group.items.map((item) => ({ ...item, number: ++number })) }));
};

const meta = (item) => [stateLabels[item.state], item.size && `size ${item.size}`, item.priority].filter(Boolean).join(" · ");

const appendWord = (line, word, prefix, continuation) => {
  if (line === prefix || line === continuation) return `${line}${word}`;
  return `${line} ${word}`;
};
const lineFits = (candidate, line, prefix, continuation) => candidate.length <= 88 || line === prefix || line === continuation;

const textLines = (text, prefix = "", continuation = " ".repeat(prefix.length)) => {
  const lines = [];
  let line = prefix;
  for (const word of text.replaceAll("<", "‹").replaceAll(">", "›").split(/\s+/u)) {
    const candidate = appendWord(line, word, prefix, continuation);
    if (lineFits(candidate, line, prefix, continuation)) {
      line = candidate;
      continue;
    }
    lines.push(line);
    line = `${continuation}${word}`;
  }
  if (line.trim()) lines.push(line);
  return lines;
};

const markdownItem = (item) => [
  ...textLines(`**${item.title}** (${meta(item)})`, `${item.number}. `, "    "),
  ...textLines(item.summary, "    "),
  ...(item.blocked_by ? textLines(`Waiting on: ${item.blocked_by}`, "    ") : []),
  ...(item.uncertainty ? textLines(`Open question: ${item.uncertainty}`, "    ") : []),
  ...(item.remaining ?? []).flatMap((step) => textLines(step, "    - ", "      ")),
  "",
];

const wishlistMarkdown = (wishlist = []) => (wishlist.length ? ["## Wishlist", "", "Ideas without a current user journey. These are not planned work.", "", ...numberedGroups({ outcomes: wishlist }).flatMap((group) => [`### ${group.title}`, "", ...group.items.flatMap(markdownItem)])] : []);

export const renderMarkdown = (tracker) => {
  const lines = ["# Chalk tracker", "", ...textLines(tracker.principle), "", ...textLines(tracker.sizing), "", "Generated from tracker.yaml; run pnpm generate:tracker after editing it.", ""];
  for (const group of numberedGroups(tracker)) lines.push(`## ${group.title}`, "", ...group.items.flatMap(markdownItem));
  lines.push(...wishlistMarkdown(tracker.wishlist));
  return `${lines.join("\n").trimEnd()}\n`;
};
