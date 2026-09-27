import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, it } from "node:test";
import { promisify } from "node:util";
import { dump } from "js-yaml";
import { generateTracker } from "./generate-tracker.mjs";
import { checkReference, groupOutcomes, readTracker, validateTracker } from "./tracker-data.mjs";
import { renderHtml, renderMarkdown } from "./tracker-render.mjs";
import { createTrackerServer } from "./tracker-server.mjs";

const temporary = [];
const roots = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "chalk-tracker-test-"));
  temporary.push(root);
  return root;
};
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const outcome = (patch = {}) => ({
  id: "conversation.registration",
  title: "People can retry a message",
  area: "product_delivery",
  state: "in_progress",
  priority: "P0",
  size: "M",
  summary: "Message sending exists; attachment retry is not connected.",
  remaining: ["Connect attachment retry to the message intent."],
  code: [],
  ...patch,
});
const tracker = (...outcomes) => ({
  schema_version: 7,
  principle: "Track concrete behavior and remaining work.",
  sizing: "Size the remaining work, not the whole feature.",
  outcomes,
});
const another = (id) => outcome({ id, priority: undefined });

it("requires a size, allows an empty owner priority, and rejects finished work", () => {
  for (const size of [undefined, "XS", "XXL", "2 days", null]) {
    assert.throws(() => validateTracker(tracker(outcome({ size }))), /size must/);
  }
  for (const size of ["S", "M", "L", "XL", "Unknown"]) {
    assert.equal(validateTracker(tracker(outcome({ size }))).outcomes[0].size, size);
  }
  assert.throws(() => validateTracker(tracker(outcome({ state: "working" }))), /unknown state/);
  assert.equal(validateTracker(tracker(outcome({ priority: "P3" }))).outcomes[0].priority, "P3");
  assert.throws(() => validateTracker(tracker(outcome({ priority: "P4" }))), /priority must/);
  assert.equal(validateTracker(tracker(outcome({ priority: undefined }))).outcomes[0].priority, undefined);
  assert.equal(validateTracker(tracker(outcome({ state: "blocked", blocked_by: "Account credentials", size: "S" }))).outcomes[0].size, "S");
});

it("requires a real uncertainty or blocker rather than an empty state label", () => {
  assert.throws(() => validateTracker(tracker(outcome({ state: "unknown" }))), /uncertainty/);
  assert.throws(() => validateTracker(tracker(outcome({ state: "blocked" }))), /blocked_by/);
  assert.throws(() => validateTracker(tracker(outcome({ state: "planned", remaining: [] }))), /remaining/);
});

it("puts the tracker principle at the top of the reading view", () => {
  assert.ok(renderMarkdown(tracker(outcome())).includes("Track concrete behavior and remaining work."));
});

it("rejects duplicate IDs and unknown fields, including evidence logs", () => {
  assert.throws(() => validateTracker(tracker(outcome(), outcome())), /duplicate outcome/);
  assert.throws(() => validateTracker(tracker(outcome({ status: "complete" }))), /unknown fields/);
  assert.throws(() => validateTracker(tracker(outcome({ evidence: [] }))), /unknown fields/);
});
it("shows every outcome once, grouped by area and numbered the same in both views", () => {
  const data = tracker(outcome(), outcome({ id: "media.join", area: "media" }), another("conversation.second"));
  const groups = groupOutcomes(data);
  assert.deepEqual(
    groups.map((group) => group.area),
    ["media", "product_delivery"],
  );
  assert.equal(groups.flatMap((group) => group.items).length, 3);
  assert.ok(renderMarkdown(data).includes("1. **People can retry a message**"));
  assert.ok(renderHtml(data).includes('<span class="number">1</span>'));
});
it("retains next steps beside uncertainty in the human reading view", () => {
  const source = renderMarkdown(
    tracker(
      outcome({
        state: "unknown",
        uncertainty: "The existing archive migration has not been verified.",
        remaining: ["Inspect existing archive cohorts before planning a migration."],
      }),
    ),
  );
  assert.ok(source.includes("Open question: The existing archive migration"));
  assert.ok(source.includes("- Inspect existing archive cohorts"));
});

it("shows state, size and an owner-set priority, escaping HTML", () => {
  const data = tracker(outcome({ size: "S", summary: "Add <contact> fields." }), outcome({ id: "conversation.unsized", size: "Unknown", priority: undefined }));
  const markdown = renderMarkdown(data);
  assert.ok(markdown.includes("(Partly working · size S · P0)"));
  assert.ok(markdown.includes("(Partly working · size Unknown)"));
  assert.ok(markdown.includes("Add ‹contact› fields."));
  const page = renderHtml(data);
  assert.ok(page.includes("Add &lt;contact&gt; fields."));
  assert.ok(!page.includes("<contact>"));
});
it("keeps the human tracker readable without HTML or implementation metadata", () => {
  const item = outcome({
    code: ["packages/core/private-path.ts"],
    theory: "theory.md#trust",
  });
  const source = renderMarkdown(tracker(item, another("conversation.second")));
  assert.ok(source.includes("## Other products"));
  assert.ok(source.includes("Partly working"));
  assert.ok(source.includes("- Connect attachment retry"));
  assert.ok(!/<[^>]+>/.test(source));
  assert.ok(!source.includes(item.id));
  assert.ok(!source.includes("private-path.ts"));
  assert.ok(!source.includes("Previous tracker IDs"));
  assert.ok(source.split("\n").every((line) => line.length <= 88));
});

it("runs the CLI through a symlink instead of silently doing nothing", async () => {
  const root = await roots();
  await writeFile(path.join(root, "tracker.yaml"), dump(tracker(outcome())));
  await symlink(import.meta.dirname, path.join(root, "tools"));
  const { stdout } = await promisify(execFile)(process.execPath, [path.join(root, "tools", "generate-tracker.mjs"), "--root", root]);
  assert.ok(stdout.includes("Generated tracker views"));
  assert.ok((await readFile(path.join(root, "tracker-human.md"), "utf8")).includes("People can retry a message"));
});

it("rejects broken anchors and paths outside the repository, including symlinks", async () => {
  const root = await roots();
  await writeFile(path.join(root, "theory.md"), "# Theory\n\n## Trust and payment\n");
  await checkReference(root, "theory.md#trust-and-payment");
  await assert.rejects(checkReference(root, "theory.md#missing"), /heading/);
  await assert.rejects(checkReference(root, "../outside.md"), /repository-relative/);
  const outside = await roots();
  await writeFile(path.join(outside, "private.md"), "not an artifact");
  await symlink(outside, path.join(root, "linked"));
  await assert.rejects(checkReference(root, "linked/private.md"), /leaves the repository/);
});

it("generates deterministically, detects drift in either view and never edits the YAML", async () => {
  const root = await roots();
  const source = dump(tracker(outcome()));
  await writeFile(path.join(root, "tracker.yaml"), source);
  await generateTracker({ root });
  const markdown = await readFile(path.join(root, "tracker-human.md"), "utf8");
  await generateTracker({ root, check: true });
  await generateTracker({ root });
  assert.equal(await readFile(path.join(root, "tracker-human.md"), "utf8"), markdown);
  for (const file of ["tracker-human.md", "tracker-human.html"]) {
    await writeFile(path.join(root, file), "stale");
    await assert.rejects(generateTracker({ root, check: true }), {
      message: `${file} is stale; run pnpm generate:tracker`,
    });
    await generateTracker({ root });
  }
  assert.equal(await readFile(path.join(root, "tracker.yaml"), "utf8"), source);
});

it("does not turn tracker text into executable HTML", () => {
  const source = renderHtml(
    tracker(
      outcome({
        title: '<img src=x onerror="alert(1)">',
        summary: "</script><script>alert(1)</script>",
      }),
    ),
  );
  assert.ok(!source.includes("<img src=x"));
  assert.ok(!source.includes("<script>alert(1)</script>"));
  assert.ok(source.includes("&lt;img"));
  assert.ok(source.includes('aria-live="polite"'));
});

it("reads only the declared tracker, not every Markdown file as governing policy", async () => {
  const root = await roots();
  await mkdir(path.join(root, "docs"));
  await writeFile(path.join(root, "docs", "unrelated.md"), "# An unrelated note");
  await writeFile(path.join(root, "tracker.yaml"), dump(tracker(outcome())));
  assert.equal((await readTracker(root)).outcomes.length, 1);
});

it("serves a read-only view and does not expose arbitrary local files", async () => {
  const root = await roots();
  const source = dump(tracker(outcome()));
  await writeFile(path.join(root, "tracker.yaml"), source);
  await writeFile(path.join(root, ".env"), "private");
  const server = createTrackerServer(root);
  const handler = server.listeners("request")[0];
  const request = async (url, method = "GET") => {
    let status;
    let body;
    await handler(
      { url, method },
      {
        writeHead(value) {
          status = value;
        },
        end(value) {
          body = value;
        },
      },
    );
    return { status, body };
  };
  assert.equal((await request("/")).status, 200);
  assert.equal((await request("/.env")).status, 404);
  assert.equal((await request("/api/capability", "POST")).status, 405);
  assert.equal(await readFile(path.join(root, "tracker.yaml"), "utf8"), source);
});
it("keeps uncertainty in both views for every unfinished state", () => {
  for (const state of ["planned", "in_progress", "blocked"]) {
    const item = outcome({
      state,
      uncertainty: "Provider recovery remains unverified.",
      ...(state === "blocked" ? { blocked_by: "A test environment" } : {}),
    });
    const data = validateTracker(tracker(item));
    assert.ok(renderMarkdown(data).includes(item.uncertainty));
    assert.ok(renderHtml(data).includes(item.uncertainty));
  }
});

it("rejects extra fragment separators instead of validating a different anchor", async () => {
  const root = await roots();
  await writeFile(path.join(root, "theory.md"), "# Main\n");
  await assert.rejects(checkReference(root, "theory.md#main#extra"), /one fragment/);
});

it("rejects executable URI schemes even when the reference names a real file", async () => {
  const root = await roots();
  await writeFile(path.join(root, "javascript:alert(1)"), "Not a safe link target");
  await assert.rejects(checkReference(root, "javascript:alert(1)"), /URI schemes/);
});

it("rejects outside-repository symlinks even for allowlisted files", async (context) => {
  const root = await roots();
  const outside = await roots();
  const privateFile = path.join(outside, "private.txt");
  await writeFile(privateFile, "private test fixture");
  await Promise.all(["theory.md", "design.md", "tracker.yaml"].map((file) => symlink(privateFile, path.join(root, file))));
  context.mock.method(console, "error", () => {});
  const handler = createTrackerServer(root).listeners("request")[0];
  for (const url of ["/theory.md", "/design.md", "/tracker.yaml", "/"]) {
    let status;
    let body;
    await handler(
      { url, method: "GET" },
      {
        writeHead(value) {
          status = value;
        },
        end(value) {
          body = value;
        },
      },
    );
    assert.equal(status, 500);
    assert.ok(!body.includes("private test fixture"));
  }
  await assert.rejects(readTracker(root), /path leaves the repository/);
});
