import { pathToFileURL } from "node:url";

const GIB = 1024 ** 3;
const DAY_MS = 24 * 60 * 60 * 1000;
// GitHub keeps 10 GiB of caches per repository and evicts the least recently used ones past that, master's included.
// The janitor stays under this budget so a burst of pull request caches never pushes out the caches master saved.
export const BUDGET_BYTES = 8 * GIB;
const QUEUE_CACHE_MAX_AGE_MS = DAY_MS;
const BRANCH_CACHE_MAX_AGE_MS = 3 * DAY_MS;

const pullNumber = (ref) => /^refs\/pull\/(\d+)\//u.exec(ref)?.[1];

/**
 * Caches to delete, each with its reason. A pull request or merge queue cache can be read only by its own ref, so it has no value
 * once the pull request is closed or the queue group has landed. Master's caches are kept unless the budget forces a choice, which
 * it never does for them: the budget step removes other refs' caches first and stops at master's.
 */
export function plan({ caches, openPulls, defaultRef, now, budgetBytes = BUDGET_BYTES }) {
  const doomed = new Map();
  const mark = (cache, reason) => doomed.has(cache.id) || doomed.set(cache.id, { cache, reason });
  const age = (cache) => now.getTime() - new Date(cache.last_accessed_at).getTime();
  for (const cache of caches) {
    if (cache.ref === defaultRef) continue;
    const number = pullNumber(cache.ref);
    if (number !== undefined) {
      if (!openPulls.has(Number(number))) mark(cache, "its pull request is closed");
    } else if (cache.ref.startsWith("refs/heads/gh-readonly-queue/")) {
      if (age(cache) > QUEUE_CACHE_MAX_AGE_MS) mark(cache, "its merge queue group has landed");
    } else if (age(cache) > BRANCH_CACHE_MAX_AGE_MS) mark(cache, "its branch was not used for 3 days");
  }
  let total = caches.reduce((sum, cache) => sum + cache.size_in_bytes, 0) - [...doomed.values()].reduce((sum, { cache }) => sum + cache.size_in_bytes, 0);
  const leastRecentFirst = caches.filter((cache) => cache.ref !== defaultRef && !doomed.has(cache.id)).sort((a, b) => new Date(a.last_accessed_at) - new Date(b.last_accessed_at));
  for (const cache of leastRecentFirst) {
    if (total <= budgetBytes) break;
    mark(cache, "the repository is over its cache budget");
    total -= cache.size_in_bytes;
  }
  return { deletions: [...doomed.values()], remainingBytes: total };
}

async function github({ fetchImpl, token, method = "GET", path }) {
  const response = await fetchImpl(`https://api.github.com/repos/${path}`, { method, headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" } }).catch(() => {
    throw new Error(`GitHub ${method} ${path} failed to connect`);
  });
  if (!response.ok) throw new Error(`GitHub ${method} ${path} answered HTTP ${response.status}: ${(await response.text().catch(() => "")).slice(0, 300)}`);
  return method === "GET" ? response.json() : undefined;
}

async function pages({ fetchImpl, token, path, pick }) {
  const items = [];
  for (let page = 1; ; page += 1) {
    const body = await github({ fetchImpl, token, path: `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}` });
    const batch = pick(body);
    items.push(...batch);
    if (batch.length < 100) return items;
  }
}

export async function janitor({ env, fetchImpl = fetch, now = new Date(), log = console.log }) {
  const missing = ["GITHUB_TOKEN", "GITHUB_REPOSITORY"].filter((name) => !env[name]);
  if (missing.length) throw new Error(`Missing required environment: ${missing.join(", ")}`);
  const { GITHUB_TOKEN: token, GITHUB_REPOSITORY: repository } = env;
  const dryRun = env.CI_JANITOR_DRY_RUN === "true";
  const { default_branch: defaultBranch } = await github({ fetchImpl, token, path: repository });
  const [caches, pulls] = await Promise.all([
    pages({ fetchImpl, token, path: `${repository}/actions/caches`, pick: (body) => body.actions_caches }),
    pages({ fetchImpl, token, path: `${repository}/pulls?state=open`, pick: (body) => body }),
  ]);
  const { deletions, remainingBytes } = plan({ caches, openPulls: new Set(pulls.map((pull) => pull.number)), defaultRef: `refs/heads/${defaultBranch}`, now });
  const freed = deletions.reduce((sum, { cache }) => sum + cache.size_in_bytes, 0);
  for (const { cache, reason } of deletions) {
    log(`${dryRun ? "would delete" : "delete"} ${cache.ref} ${cache.key.slice(0, 40)} ${(cache.size_in_bytes / 1024 ** 2).toFixed(0)} MiB: ${reason}`);
    if (!dryRun) await github({ fetchImpl, token, method: "DELETE", path: `${repository}/actions/caches/${cache.id}` });
  }
  log(`${caches.length} caches, ${(freed / GIB).toFixed(2)} GiB ${dryRun ? "to free" : "freed"} in ${deletions.length} deletions, ${(remainingBytes / GIB).toFixed(2)} GiB left`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    await janitor({ env: process.env });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
