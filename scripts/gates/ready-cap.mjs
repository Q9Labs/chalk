import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Only this many pull requests against master are ready (not draft) at once, whoever opened them. The merge queue lands about two
// pull requests an hour on hosted runners, and every push to a ready pull request reruns the Gate, so a long line of ready pull
// requests costs more in cancelled reruns than it saves. A repository variable CHALK_READY_CAP replaces the default without a code change.
export const DEFAULT_CAP = 6;
export const EXEMPT_LABEL = "ready-cap-exempt";

const QUERY = `query($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, baseRefName: "master", first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { id number isDraft labels(first: 20) { nodes { name } } mergeQueueEntry { id } }
    }
  }
}`;

/** readCap returns the cap from the raw variable text, or the default when it is unset. A set value that is not a whole number of 1 or more is an error, not a silent default. */
export function readCap(raw) {
  if (raw === undefined || raw.trim() === "") return DEFAULT_CAP;
  if (!/^[1-9][0-9]*$/u.test(raw.trim())) throw new Error(`CHALK_READY_CAP must be a whole number of 1 or more, got "${raw}"`);
  return Number(raw.trim());
}

/** decide counts the ready pull requests other than `self` and says whether marking `self` ready would pass the cap. Pull requests in the merge queue are ready ones, so they are inside the count. */
export function decide({ pullRequests, self, cap }) {
  const ready = pullRequests.filter((pr) => !pr.isDraft && pr.number !== self?.number);
  const queued = ready.filter((pr) => pr.mergeQueueEntry !== null).length;
  const exempt = Boolean(self) && self.labels.nodes.some((label) => label.name === EXEMPT_LABEL);
  return { others: ready.length, queued, cap, exempt, over: !exempt && ready.length >= cap };
}

// The token is the job's GITHUB_TOKEN in the Gate and the developer's own login locally; fetch needs no gh on the runner.
const readToken = () => process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();

async function graphql(query, variables) {
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { authorization: `bearer ${readToken()}`, "content-type": "application/json", "user-agent": "chalk-ready-cap" },
    body: JSON.stringify({ query, variables }),
  });
  const payload = await response.json();
  if (!response.ok || payload.errors) throw new Error(`GitHub GraphQL failed (${response.status}): ${JSON.stringify(payload.errors ?? payload)}`);
  return payload.data;
}

async function openPullRequests(owner, name) {
  const found = [];
  let cursor = null;
  for (;;) {
    const page = (await graphql(QUERY, { owner, name, cursor })).repository.pullRequests;
    found.push(...page.nodes);
    if (!page.pageInfo.hasNextPage) return found;
    cursor = page.pageInfo.endCursor;
  }
}

async function explainRefusal(self, result) {
  const body = [
    `Over the ready cap: ${result.others} other pull requests are ready against master (${result.queued} in the merge queue), and the cap is ${result.cap}. \`Root gate\` fails on this pull request until it is a draft again.`,
    "",
    `Run \`gh pr ready --undo ${self.number}\`. Every push to a ready pull request reruns the Gate, and a long line of them is mostly cancelled reruns, so keep working here as a draft (a push to a draft runs nothing) and mark it ready when \`node scripts/gates/ready-cap.mjs --pr ${self.number}\` says there is room.`,
    "",
    `Related changes belong in one pull request. Maintainers can raise the cap with the repository variable \`CHALK_READY_CAP\`, or let one pull request through with the \`${EXEMPT_LABEL}\` label.`,
  ].join("\n");
  await graphql("mutation($id: ID!, $body: String!) { addComment(input: {subjectId: $id, body: $body}) { subject { id } } }", { id: self.id, body });
}

function parseArgs(argv) {
  const options = { pr: undefined, enforce: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--enforce") options.enforce = true;
    else if (argv[index] === "--pr") options.pr = Number(argv[(index += 1)]);
    else throw new Error(`Unknown argument ${argv[index]}. Usage: ready-cap.mjs [--pr <number>] [--enforce]`);
  }
  if (options.pr !== undefined && !Number.isInteger(options.pr)) throw new Error("--pr needs a pull request number");
  if (options.enforce && options.pr === undefined) throw new Error("--enforce needs --pr");
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const repository = process.env.GITHUB_REPOSITORY ?? execFileSync("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], { encoding: "utf8" }).trim();
  const [owner, name] = repository.split("/");
  const cap = readCap(process.env.CHALK_READY_CAP);
  const pullRequests = await openPullRequests(owner, name);
  const self = options.pr === undefined ? undefined : pullRequests.find((pr) => pr.number === options.pr);
  if (options.pr !== undefined && !self) throw new Error(`Pull request ${options.pr} is not open against master`);
  const result = decide({ pullRequests, self, cap });
  const verdict = result.exempt ? `exempt (${EXEMPT_LABEL})` : result.over ? "OVER" : "ok";
  console.log(`${result.others} other ready pull requests against master (${result.queued} in the merge queue), cap ${cap}: ${verdict}`);

  if (!options.enforce) {
    if (result.over) console.error(`Do not mark ${self ? `#${self.number}` : "another pull request"} ready yet: wait for a merge, or batch the change into a ready pull request that is already there.`);
    process.exitCode = result.over ? 1 : 0;
    return;
  }
  // The Gate reads this output first: over the cap, Select gate jobs stands down and Root gate fails. The comment comes after, so a failed comment cannot unbind the cap.
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `capped=${result.over}\n`);
  if (result.over) await explainRefusal(self, result);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
