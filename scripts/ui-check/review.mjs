// Vision review of the screens that changed. One request holds up to MAX_SCREENS before | after images and asks one
// question per screen: is anything visibly broken. A finding blocks only when it names a region that overlaps a
// region the pixel comparison found changed, so the model cannot block on something the branch did not touch.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const MODEL = process.env.UI_CHECK_MODEL ?? "claude-fable-5-2";
export const MAX_SCREENS = 10;
/** Screens whose changed pixels are under this fraction are font or antialiasing noise, not worth a model call. */
export const MIN_CHANGED_FRACTION = 0.0005;
/** US dollars per million tokens for MODEL, from Anthropic's pricing page. Update with MODEL. */
const PRICE_PER_MTOK = { input: Number(process.env.UI_CHECK_PRICE_IN ?? 8), output: Number(process.env.UI_CHECK_PRICE_OUT ?? 40) };

const SYSTEM = `You review screenshots of a video-call web app for visible breakage. Each image shows BEFORE on the left and AFTER on the right; red boxes mark pixels that changed. Judge only the AFTER picture, and only what the change touched.

Report a screen as broken only for a defect a user would see and be hurt by:
- one element covers or hides another, or a control is out of reach (a sheet over the call controls, a button behind a layer)
- tiles or panels overlap, or leave an unexplained hole or gap in a layout
- text or an icon is cut off, overflows its box or the screen, or collides with other text
- a control has no visible label or looks disabled when it should not
- an empty, loading or error state is blank, shows raw keys or placeholders, or is missing its message
- contrast so low that text cannot be read

Do not report taste: spacing preferences, color choices, wording, or anything that looks the same before and after. When BEFORE already has the same defect, it is not new.

Answer with JSON only: {"screens":[{"frame":"<id>","broken":true|false,"finding":"<one sentence naming the element and the defect>","region":{"x":0..1,"y":0..1,"w":0..1,"h":0..1}}]}. region is a box around the defect as fractions of the AFTER picture, and is required when broken is true.`;

const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * @param {{ comparisons: { frame: string, label: string, size: string, scheme: string, fraction: number, changed: number, regions: { x: number, y: number, w: number, h: number }[], afterWidth: number, afterHeight: number }[], dir: string, apiKey: string | undefined }} input
 */
export async function reviewScreens({ comparisons, dir, apiKey }) {
  const candidates = comparisons
    .filter((item) => item.fraction >= MIN_CHANGED_FRACTION)
    .sort((a, b) => b.changed - a.changed)
    .slice(0, MAX_SCREENS);
  if (candidates.length === 0) return { status: "nothing-to-review", findings: [], reviewed: 0, cost: 0 };
  if (!apiKey) return { status: "skipped-no-key", findings: [], reviewed: 0, cost: 0 };
  const content = [];
  for (const item of candidates) {
    content.push({ type: "text", text: `Screen ${item.frame}: ${item.label}, ${item.size}, ${item.scheme} theme.` });
    content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: (await readFile(join(dir, `${item.frame}.review.jpg`))).toString("base64") } });
  }
  content.push({ type: "text", text: "Return the JSON now." });
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 2000, system: SYSTEM, messages: [{ role: "user", content }] }),
  });
  if (!response.ok) return { status: `error-${response.status}`, findings: [], reviewed: 0, cost: 0, error: (await response.text()).slice(0, 300) };
  const body = await response.json();
  const cost = ((body.usage?.input_tokens ?? 0) * PRICE_PER_MTOK.input + (body.usage?.output_tokens ?? 0) * PRICE_PER_MTOK.output) / 1_000_000;
  const text = body.content?.find((part) => part.type === "text")?.text ?? "";
  let screens;
  try {
    screens = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)).screens;
  } catch {
    return { status: "error-unparseable", findings: [], reviewed: candidates.length, cost, error: text.slice(0, 300) };
  }
  const byFrame = new Map(candidates.map((item) => [item.frame, item]));
  const findings = [];
  for (const screen of screens ?? []) {
    const item = byFrame.get(screen.frame);
    if (!item || screen.broken !== true) continue;
    const region = screen.region;
    const pointed = region && [region.x, region.y, region.w, region.h].every((value) => typeof value === "number");
    const touched = pointed && item.regions.some((changed) => overlaps(region, { x: changed.x / item.afterWidth, y: changed.y / item.afterHeight, w: changed.w / item.afterWidth, h: changed.h / item.afterHeight }));
    findings.push({ frame: item.frame, label: item.label, size: item.size, scheme: item.scheme, finding: String(screen.finding ?? ""), region: pointed ? region : null, blocking: Boolean(touched) });
  }
  return { status: "ok", findings, reviewed: candidates.length, cost, tokens: body.usage };
}
