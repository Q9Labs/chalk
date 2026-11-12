# Run the Chalk MCP evaluation

Compares a fresh Claude Code session using the curated `/mcp` tools (`--arm tools`) with the same model using `/mcp/code` (`--arm code`). Both arms use the same model, effort, system prompt, fixture, tasks and graders. Defaults (tasks, `--k`, concurrency, timeout, per-trial budget) are in `run.py`.

## Start a disposable stack

Prerequisites: Linux with Docker, Go from `apps/api/go.mod`, a PostgreSQL 18 client, Python 3.10+ and Git. The trial machine also needs an authenticated Claude Code CLI. No Python packages or extra Node dependencies are needed.

Run heavy work on Instabox. Commit and push the harness first. For a comparison against another branch, fetch it and use it as the source for **both** arms:

```sh
box run --keep --fetch feat/mcp-code-mode -- 'tmux new-session -d -s mcp-eval -c "$PWD" "CHALK_EVAL_SERVER_REF=origin/feat/mcp-code-mode bash scripts/evals/mcp/stack.sh > /tmp/chalk-mcp-stack.log 2>&1"; pwd'
```

For a tools-only run, omit `--fetch` and `CHALK_EVAL_SERVER_REF`. You can also run `bash scripts/evals/mcp/stack.sh` directly on a disposable Linux machine. `CHALK_EVAL_SERVER_REF` archives committed sources into a fresh private directory and never switches, merges or edits the source branch.

`stack.sh` starts a new PostgreSQL container, applies the repo's migrations, builds the opt-in `mcp_eval` test host and listens on `127.0.0.1:18080`. Wait for `MCP eval ready` in the log. No provider or production credentials are required.

The host uses the production HTTP router, MCP handlers, authentication, authorization, domain services and Postgres adapters. It does **not** start cloud workers, Sync, media sessions, storage downloads or a webhook delivery worker, so this is an operations benchmark, not a media, provider or delivery-latency benchmark.

If Claude runs elsewhere, set `EVAL_HOST` to the stack machine's SSH alias and `EVAL_CHECKOUT` to the checkout path `box` printed, and keep this forward running:

```sh
ssh -N -L 18080:127.0.0.1:18080 -L 25432:127.0.0.1:25432 "$EVAL_HOST"
export CHALK_EVAL_SSH_HOST="$EVAL_HOST"
export CHALK_EVAL_SERVER_LOG="$EVAL_CHECKOUT/.private/mcp-eval-stack/api.jsonl"
```

For a nondefault SSH config, set `CHALK_EVAL_SSH_CONFIG`. On the stack machine itself, omit the exports and run from the repo root.

## Run each arm

Each command resets only the marked, loopback `chalk_mcp_eval` database; do not use it for anything else. A database advisory lock prevents concurrent arm runs. Each trial gets its own tenant with deterministic IDs and freshly randomized credentials, so mutations cannot affect another trial.

```sh
python3 scripts/evals/mcp/run.py run --arm tools --output .private/mcp-evals/tools.json
python3 scripts/evals/mcp/run.py run --arm code --output .private/mcp-evals/code.json
python3 scripts/evals/mcp/run.py report .private/mcp-evals/tools.json .private/mcp-evals/code.json --output .private/mcp-evals/comparison.md
```

Add `--k 1` for a cheap proof, which cannot decide which arm to keep. Use `--task <id>` (repeatable) for diagnosis; subset runs are labeled by their task list and must not be compared with full runs. Infrastructure failures return exit code 2; ordinary task failures do not abort the suite.

Preflight runs before any paid trial and a failure stops the run. Every trial is a new `claude -p` process in an empty temporary directory with `--strict-mcp-config`, no built-in tools, disabled hooks and settings discovery, and only Chalk MCP permissions. The runner checks the tools actually offered and the model actually used. `report` refuses incomplete runs or mismatched model, settings, prompts, fixture, tasks, CLI, harness revision or API source revision; alternate arm order across repeated full runs to reduce cache and order bias.

## Grading and accounting

- Graders in `tasks.py` require exact types and values, and write tasks also query resulting database state. No LLM graders are used. A refusal task must hit the specific server-side error event, not just a plausible refusal.
- The fixture is in `fixture.py`. Transcript bodies live in `mcp_eval_objects`, a fixture-only table the eval host serves as its object store, so the API's artifact checks run unchanged. The `/mcp/code` arm has no transcript text API.
- Resource IDs are derived deterministically with UUIDv4 version bits because webhook event contracts reject other versions.
- API JSON logs supply per-tenant completion counts and errors, taken as before and after counters so old logs cannot validate a new trial. Missing server evidence invalidates a trial even if its answer matches.
- Reports carry Wilson 95% pass-rate intervals (descriptive, since repetitions are correlated), token counts, CLI-reported cost, wall time and call and error counts. CLI cost is not a complete bill.
- `unsupported_capability` records only the model's reported response; it does not prove the API lacks the operation. Invalid JSON is always a failure.
- Raw Claude streams, tool inputs and results, answers, issued keys and transcript bodies are never written to result logs. Do not commit private runtime artifacts.

## Add or change a task

1. Add synthetic rows to `fixture.py` if needed. Keep facts and IDs stable across arms and keep external services out of the fixture.
2. Add a `Task` in `tasks.py` with a precise JSON answer shape and an independent expected value; for writes, add a tenant-scoped SQL state query.
3. Extend preflight when a fixture projection changes, and run the task through the real API. Never update an oracle just to agree with an agent answer.
4. Run a focused paid trial with `--k 1 --task your-task-id`.

The API gate runs the Python checks, shell syntax check and tagged host compile. Eval sessions never run in CI.

## Cost and cleanup

A full comparison is many paid trials, and an in-flight request can overshoot a per-trial budget, so check the defaults in `run.py` and start with `--k 1`.

Stop the stack with Ctrl-C or `tmux send-keys -t mcp-eval C-c`, then stop the SSH forward. The script removes its Postgres container. Delete the kept Instabox when finished with `instabox rm "$EVAL_BOX"`.
