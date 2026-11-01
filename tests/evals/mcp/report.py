"""Deterministic summaries; confidence intervals are descriptive, not a ship gate."""

import collections
import json
import math
import statistics
from pathlib import Path


def wilson(passed, total):
    if not total:
        return [0.0, 1.0]
    z = 1.959963984540054
    p = passed / total
    denominator = 1 + z * z / total
    center = (p + z * z / (2 * total)) / denominator
    radius = z * math.sqrt(p * (1 - p) / total + z * z / (4 * total * total)) / denominator
    return [max(0.0, center - radius), min(1.0, center + radius)]


def summarize(trials):
    passed = sum(t["passed"] for t in trials)
    eligible = [t for t in trials if not t["capability_gap"]]
    return {
        "trials": len(trials), "passed": passed,
        "pass_rate": passed / len(trials) if trials else 0,
        "pass_rate_95ci_wilson": wilson(passed, len(trials)),
        "operational_passed": sum(t["passed"] for t in eligible), "operational_trials": len(eligible),
        "operational_95ci_wilson": wilson(sum(t["passed"] for t in eligible), len(eligible)),
        **{key: sum(t.get(key, 0) for t in trials) for key in (
            "input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens",
            "cost_usd", "wall_seconds", "turns", "tool_calls", "tool_errors", "server_calls", "server_errors",
        )},
        "median_wall_seconds": statistics.median(t["wall_seconds"] for t in trials) if trials else 0,
        "failures": dict(collections.Counter(t["category"] for t in trials if not t["passed"])),
    }


def markdown(runs):
    by_arm = {r["config"]["arm"]: r for r in runs}
    arms = [a for a in ("tools", "code") if a in by_arm]
    lines = ["# Chalk MCP evaluation", "", "Verdict: inconclusive (a proof run is not a model-selection benchmark).", "",
             "| Metric | " + " | ".join(arms) + " |", "|---|" + "---|" * len(arms)]

    def row(label, render):
        lines.append("| " + label + " | " + " | ".join(render(by_arm[a]) for a in arms) + " |")

    def rate(run):
        s = run["summary"]
        lo, hi = s["pass_rate_95ci_wilson"]
        return f'{s["passed"]}/{s["trials"]} ({s["pass_rate"]:.1%}; 95% CI {lo:.1%}–{hi:.1%})'

    row("All tasks", rate)
    row("Operational tasks (excludes text capability gaps)", lambda r: f'{r["summary"]["operational_passed"]}/{r["summary"]["operational_trials"]}')
    for label, key in [("Uncached input tokens", "input_tokens"), ("Output tokens", "output_tokens"),
                       ("Cache read tokens", "cache_read_input_tokens"), ("Cache creation tokens", "cache_creation_input_tokens"),
                       ("Assistant turns", "turns"), ("Client tool calls", "tool_calls"), ("Client tool errors", "tool_errors"),
                       ("Server completed calls", "server_calls"), ("Server error calls", "server_errors")]:
        row(label, lambda r, k=key: str(r["summary"][k]))
    row("Cost (CLI list-price accounting, USD)", lambda r: f'${r["summary"]["cost_usd"]:.4f}')
    row("Sum of trial wall times (seconds)", lambda r: f'{r["summary"]["wall_seconds"]:.1f}')
    row("Run elapsed (seconds, including fixtures)", lambda r: f'{r["elapsed_seconds"]:.1f}')
    row("Median trial (seconds)", lambda r: f'{r["summary"]["median_wall_seconds"]:.1f}')
    lines += ["", "## Tasks", "", "★ marks different pass counts between arms; † marks a transcript text capability gap.", "",
              "| Task | " + " | ".join(arms) + " |", "|---|" + "---|" * len(arms)]
    task_ids = list(dict.fromkeys(t["task"] for r in runs for t in r["trials"]))
    for task_id in task_ids:
        cells, outcomes, gap = [], [], False
        for arm in arms:
            trials = [t for t in by_arm[arm]["trials"] if t["task"] == task_id]
            good = sum(t["passed"] for t in trials)
            outcomes.append((good, len(trials)))
            gap = gap or any(t["capability_gap"] for t in trials)
            failures = sorted({t["category"] for t in trials if not t["passed"]})
            cells.append(f'{good}/{len(trials)}' + (" — " + ", ".join(failures) if failures else ""))
        marker = (" ★" if len(set(outcomes)) > 1 else "") + (" †" if gap else "")
        lines.append("| " + task_id + marker + " | " + " | ".join(cells) + " |")
    lines += ["", "## Interpretation", "",
              "- Every trial must have a successful fresh Claude session and API-side completed calls. Missing server evidence fails the trial even if the answer matches.",
              "- Passes require exact JSON facts and, for writes, the resulting DB state plus read-back evidence. No LLM graders are used.",
              "- The base /mcp catalog has no transcript text-read/search tools. Four text tasks remain failures, also reported separately from the 20 operational tasks. Their synthetic corpus is stored in a fixture-only table, not a production object-store emulator.",
              "- Wilson 95% intervals treat trials as independent. Repeated tasks are correlated; these intervals are descriptive and understate task-selection uncertainty. k=1 is only a harness proof.",
              "- CLI accounting includes auxiliary-model overhead (if any), caching, startup and MCP discovery; wall time includes retries. Server counts include rejected calls. Expected scope rejection is not itself a failed task.",
              "- A webhook test proves enqueueing, not external delivery. No live media/provider, production service or real customer data participates.",
              "- Do not choose an arm until both complete on the same revision, fixture, settings and task set; alternate arms across repeated runs to reduce cache/load/order bias."]
    if "tools" in by_arm and "code" not in by_arm:
        run = by_arm["tools"]
        scale = 6 / run["config"]["k"]
        lines += ["", "## Full-run estimate", "",
                  f'Both arms at k=3: approximately ${run["summary"]["cost_usd"] * scale:.2f} and {run["elapsed_seconds"] * scale / 60:.1f} minutes at the same concurrency, assuming code mode costs/takes the same as tools. This is an extrapolation, not a measured code-mode result.']
    return "\n".join(lines) + "\n"


def write_report(paths, output):
    runs = [json.loads(Path(p).read_text()) for p in paths]
    if len({r["config"]["arm"] for r in runs}) != len(runs):
        raise ValueError("Compare at most one result per arm")
    fields = ("model", "effort", "k", "concurrency", "timeout", "budget", "suite_sha256", "fixture_sha256", "system_sha256", "revision", "cli_version")
    if any(any(r["config"][field] != runs[0]["config"][field] for field in fields) for r in runs[1:]):
        raise ValueError("Cannot compare runs with different revisions, tasks, prompts, CLI or settings")
    Path(output).write_text(markdown(runs))
