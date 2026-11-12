// Vision review of the screens that changed. One headless Claude Code run (`claude -p`, on the Q9 Claude subscription, no API
// key) reads up to MAX_SCREENS before | after images and answers one question per screen: is anything visibly broken. A
// finding blocks only when it names a region that overlaps a region the pixel comparison found changed, so the model cannot
// block on something the branch did not touch.
import { execFile } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

const MODEL = process.env.UI_CHECK_MODEL ?? "claude-opus-5-5";
const EFFORT = "high";
const MAX_SCREENS = 10;
/** Screens whose changed pixels are under this fraction are font or antialiasing noise, not worth a model call. */
const MIN_CHANGED_FRACTION = 0.0005;
const TIMEOUT_MS = 8 * 60_000;

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

/** The screens the model judged broken, each with whether it points at a region the pixel comparison found changed. */
function toFindings(screens, candidates) {
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
  return findings;
}

/**
 * @param {{ comparisons: { frame: string, label: string, size: string, scheme: string, fraction: number, changed: number, regions: { x: number, y: number, w: number, h: number }[], afterWidth: number, afterHeight: number }[], dir: string, token: string | undefined }} input
 * `dir` holds `<frame>.review.jpg` for every compared frame; `token` is a Claude subscription OAuth token (`claude setup-token`).
 */
export async function reviewScreens({ comparisons, dir, token }) {
  const candidates = comparisons
    .filter((item) => item.fraction >= MIN_CHANGED_FRACTION)
    .sort((a, b) => b.changed - a.changed)
    .slice(0, MAX_SCREENS);
  if (candidates.length === 0) return { status: "nothing-to-review", findings: [], reviewed: 0 };
  if (!token) return { status: "skipped-no-token", findings: [], reviewed: 0 };
  const prompt = ["Read each of these images with the Read tool, then return the JSON.", ...candidates.map((item) => `- ${item.frame}.review.jpg is screen ${item.frame}: ${item.label}, ${item.size}, ${item.scheme} theme.`)].join("\n");
  const args = [
    "-p",
    prompt,
    "--model",
    MODEL,
    "--effort",
    EFFORT,
    "--output-format",
    "json",
    "--system-prompt",
    SYSTEM,
    "--tools",
    "Read",
    "--allowedTools",
    "Read",
    "--permission-mode",
    "dontAsk",
    "--setting-sources",
    "",
    "--disable-slash-commands",
    "--strict-mcp-config",
    "--no-session-persistence",
  ];
  // The CLI runs in a fresh folder outside the checkout, with only the images in it and an empty home, so it finds no CLAUDE.md,
  // settings or other file of the pull request to follow or read.
  const work = mkdtempSync(join(tmpdir(), "ui-check-review-"));
  for (const item of candidates) copyFileSync(join(dir, `${item.frame}.review.jpg`), join(work, `${item.frame}.review.jpg`));
  mkdirSync(join(work, "home"));
  let output;
  try {
    const { stdout } = await run("claude", args, { cwd: work, timeout: TIMEOUT_MS, maxBuffer: 10_000_000, env: { PATH: process.env.PATH, HOME: join(work, "home"), CLAUDE_CODE_OAUTH_TOKEN: token } });
    output = stdout;
  } catch (error) {
    return { status: "error-claude", findings: [], reviewed: 0, error: String(error.stderr || error.stdout || error.message).slice(0, 300) };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  let result;
  try {
    result = JSON.parse(output);
  } catch {
    return { status: "error-unparseable", findings: [], reviewed: candidates.length, error: output.slice(0, 300) };
  }
  const text = typeof result.result === "string" ? result.result : "";
  if (result.is_error) return { status: "error-claude", findings: [], reviewed: 0, error: text.slice(0, 300) };
  let screens;
  try {
    screens = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)).screens;
  } catch {
    return { status: "error-unparseable", findings: [], reviewed: candidates.length, error: text.slice(0, 300) };
  }
  // A missing judgment is not a pass: every screen sent must come back with a verdict.
  const judged = new Set(Array.isArray(screens) ? screens.filter((screen) => typeof screen?.broken === "boolean").map((screen) => screen.frame) : []);
  const missing = candidates.filter((item) => !judged.has(item.frame));
  if (missing.length > 0) return { status: "error-incomplete", findings: [], reviewed: 0, error: `no verdict for ${missing.map((item) => item.frame).join(", ")}`.slice(0, 300) };
  return { status: "ok", findings: toFindings(screens, candidates), reviewed: candidates.length };
}
