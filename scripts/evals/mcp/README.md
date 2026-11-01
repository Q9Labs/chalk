# Run the Chalk MCP evaluation

Compare a fresh Claude Code session using the 33 curated `/mcp` tools with the same model using `/mcp/code`. Both arms use `claude-sonnet-5-5`, medium effort, the same system prompt, fixture, tasks and graders. The default is 24 tasks, three repetitions each, concurrency two, a 240-second trial timeout and a $1.50 per-trial budget.

Twenty tasks cover lookups, cross-Space attendance aggregation, live Episodes, admission requests, recording exports, multilingual transcript metadata, memberships, webhook history and verified writes. Four tasks ask for transcript text, including Urdu script, Arabic and a 4,500-segment transcript. The base catalog cannot read that text. These tasks remain failures, labeled as capability gaps, and the report also gives the operational-only pass rate. Do not count an honest unsupported answer as a successful text search.

## Start a disposable stack

Prerequisites: Linux with Docker, Go from `apps/api/go.mod`, PostgreSQL 18 client, Python 3.10+ and Git. The trial machine additionally needs an authenticated Claude Code CLI supporting the flags shown by `claude --help`. No Python packages or additional Node dependencies are needed.

Run heavy work on Instabox. Commit and push the harness first. For a comparison, fetch the code-mode branch too and use it as the source for **both** arms:

```sh
box run --keep --fetch feat/mcp-code-mode -- 'tmux new-session -d -s mcp-eval -c "$PWD" "CHALK_EVAL_SERVER_REF=origin/feat/mcp-code-mode bash scripts/evals/mcp/stack.sh > /tmp/chalk-mcp-stack.log 2>&1"; pwd'
```

For a tools-only run, omit `--fetch feat/mcp-code-mode` and `CHALK_EVAL_SERVER_REF=origin/feat/mcp-code-mode`. Alternatively, run `bash scripts/evals/mcp/stack.sh` directly on a disposable Linux machine. `CHALK_EVAL_SERVER_REF` archives committed API/MCP sources into a fresh private directory and overlays the tagged eval host. It never switches, merges or edits the source branch.

`stack.sh` creates a new PostgreSQL 18.3 container, applies the repo's migrations, builds the opt-in `mcp_eval` test host and listens on `127.0.0.1:18080`. Wait for `MCP eval ready` in `/tmp/chalk-mcp-stack.log`. Build/migration logs and the API JSON log are under `<checkout>/.private/mcp-eval-stack/`. No provider or production credentials are required.

The host uses the production HTTP router, MCP handlers, authentication, authorization, domain services and Postgres adapters. It does **not** start cloud workers, Sync, media sessions, storage downloads or a webhook delivery worker. Unused media/admission-issuance ports reuse existing integration fixtures. This is an operations benchmark, not a media/provider or delivery-latency benchmark.

If Claude runs elsewhere, use your machine's normal SSH configuration. Set `EVAL_HOST` to its SSH alias and `EVAL_CHECKOUT` to the checkout path printed by `box`. Keep this forward running in a separate terminal:

```sh
ssh -N -L 18080:127.0.0.1:18080 -L 25432:127.0.0.1:25432 "$EVAL_HOST"
```

Configure the runner's server-log reader:

```sh
export CHALK_EVAL_SSH_HOST="$EVAL_HOST"
export CHALK_EVAL_SERVER_LOG="$EVAL_CHECKOUT/.private/mcp-eval-stack/api.jsonl"
```

For a nondefault SSH config, set `CHALK_EVAL_SSH_CONFIG`. When running on the stack machine, omit these exports and run from the repo root. The runner reads the API source revision stamp next to its log.

## Run each arm

Each command resets only the marked, loopback `chalk_mcp_eval` database. A database advisory lock prevents concurrent arm runs, including runners on different machines. Each trial gets its own tenant with deterministic resource IDs and fixture contents; API credentials are freshly randomized. Mutations cannot affect another trial. Do not use this database for any other work.

```sh
python3 scripts/evals/mcp/run.py run --arm tools --output .private/mcp-evals/tools.json
```

```sh
python3 scripts/evals/mcp/run.py run --arm code --output .private/mcp-evals/code.json
```

For the inexpensive proof, add `--k 1` to each command. For diagnosis, use `--task frequent-attendees` or repeat `--task` to select a subset. Subset runs are labeled by their exact task list and must not be compared with full runs. Infrastructure failures return exit code 2; ordinary task failures are reported without aborting the suite.

Before paying for trials, preflight checks the catalog, real export states, canonical pending admissions, an in-place key rotation, webhook test enqueueing and the specific tenant-update scope rejection. The code arm also executes a real sandbox call. A failed preflight stops the run. Every trial has a new `claude -p` process in an empty temporary working directory, `--strict-mcp-config`, `--tools ''`, disabled hooks/settings discovery and only Chalk MCP permissions. The runner also checks the tools actually offered and the model actually used.

Generate a comparison after both arms complete on the same source revision and runner settings:

```sh
python3 scripts/evals/mcp/run.py report .private/mcp-evals/tools.json .private/mcp-evals/code.json --output .private/mcp-evals/comparison.md
```

Results and per-arm Markdown reports checkpoint after each trial. Comparison refuses incomplete runs or mismatched model, settings, prompts, fixture, task list, CLI, harness revision or API source revision. Alternate arm order across repeated full runs to reduce cache/order bias. A k=1 proof cannot decide which arm to keep.

## Recorded proof

The [November 1, 2026 comparison](proof/comparison-k1.md) contains full-suite k=1 runs for both arms, with sanitized [tools JSON](proof/tools-k1.json) and [code JSON](proof/code-k1.json). Both used harness `47cffbf3f`, API source `529a9e7e9db6` and Claude Code 2.1.316. Tools passed 20/20 operational tasks; code passed 19/20, reporting attendance as unsupported. Both failed the four known transcript-text gaps. Every trial had API-side evidence and complete CLI accounting.

The observed CLI costs were $0.4658 (tools) and $0.8971 (code). Elapsed times including fixtures and SSH were 10.0 and 12.1 minutes. A linear extrapolation gives approximately **$4.09 and 66 minutes** for both arms at k=3, concurrency two. This is not a measured k=3 result or a winner selection.

## Grading and accounting

- `tasks.py` specifies requested JSON facts. Graders require exact types/values, including names, counts and timestamps. Write tasks additionally query resulting DB state. Rotation must change the existing row's credential hash and prefix while preserving its ID, name and scopes. The scope task requires the specific `chalk_update_tenant:auth.forbidden` server event, not just a plausible refusal or an unrelated error. No LLM graders are used.
- The fixture includes four Spaces, eight Episodes, attendance, a canonical pending admission, four recordings with ready/failed exports, multilingual transcript metadata and corpus, three memberships, two keys, an inert webhook and two historical deliveries. Transcript bodies live in `mcp_eval_objects`, a fixture-only corpus table, not a pretend production object store. Neither current arm has a text-read API. Add a real storage fixture before claiming transcript-content coverage after such an API ships.
- Resource IDs are deterministically derived with UUIDv4 version bits because webhook event contracts reject other UUID versions. Historical Episode dates are fixed task facts; capture completion uses PostgreSQL's current transaction time so export retention does not expire the fixture on future runs.
- API JSON logs supply per-tenant completion counts and errors. The runner takes before/after counters, so old logs cannot validate a new trial. Code-mode audit counters and inner shared-operation counts remain separate, exposing batching. Missing server evidence invalidates a trial even if its answer happens to match.
- Reports include Wilson 95% pass-rate intervals, uncached input/output/cache tokens, CLI-reported USD cost, wall time, turns, client tool calls/errors, server calls/errors and failure categories. CLI accounting includes auxiliary-model overhead when Claude reports it. Incomplete accounting is explicit; do not treat its cost as a complete bill. Repetitions of a task are correlated, so the intervals are descriptive, not a population guarantee.
- `unsupported_capability` records the model's reported unsupported response; it does not prove the API lacks that operation. Only the four `capability_gap` tasks identify known catalog limitations. Invalid JSON is a failure even when its task is a known gap.
- Prompts require reading writes back. The grader checks facts and DB state identically for both arms; it does not infer read-back execution from generated code. Webhook testing proves a queued `endpoint.test` delivery, not an external HTTP success.
- Raw Claude streams, tool inputs/results, final answers, issued keys and transcript bodies are never written to result logs. Only aggregate/token/model metadata, fixture IDs and check booleans persist. Do not commit private runtime artifacts.

## Add or change a task

1. Add synthetic rows to `fixture.py` if needed. Keep facts and IDs stable across arms and keep external services out of the fixture.
2. Add a `Task` in `tasks.py` with a precise JSON answer shape and an independent expected value. For writes, add a tenant-scoped SQL state query. For unsupported capabilities, set `capability_gap=True` without changing the expected factual answer into a refusal.
3. Extend preflight when changing a fixture projection, then run the task through the real API. Do not update an oracle merely to agree with an agent answer.
4. Run the harness checks and a focused paid trial:

```sh
python3 -m unittest discover -s scripts/evals/mcp -p 'test_*.py' -v
python3 scripts/evals/mcp/run.py run --arm tools --k 1 --task your-task-id --output .private/mcp-evals/diagnostic.json
```

The API gate runs the Python checks, shell syntax check and tagged host compile. Eval sessions are never run in CI and need no CI model credentials.

## Cost, time and cleanup

A full comparison is 144 trials. The configured stop budgets total $216, though an in-flight request can overshoot a CLI budget. Actual cost should be much lower; use the committed proof report's measured extrapolation. Trial timeouts bound model execution to 240 seconds each. At concurrency two, the model-time upper bound is about 4.8 hours for both arms, plus fixtures, SSH and setup. These are bounds, not performance estimates.

Stop the stack with Ctrl-C or `tmux send-keys -t mcp-eval C-c`, then stop the SSH forward. The script stops its host and removes its owned Postgres container. Delete the kept Instabox when finished:

```sh
instabox rm "$EVAL_BOX"
```
