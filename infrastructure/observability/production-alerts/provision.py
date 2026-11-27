#!/usr/bin/env python3
"""Reconcile only the three named Chalk monitors.

The monitors have no notifier: they still evaluate, and the API readiness and the goal check read their state. This
file creates and references no delivery target. It and the files beside it are the only source of the monitors:
--check lists every way the live monitors differ from them, and a notifier attached in the console is drift."""

import argparse
import json
import os
from pathlib import Path
import re
import sys
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


# Thresholds of the Chalk SFU rules, set only here. The APL files read them as ${NAME}.
THRESHOLDS = {
    # A healthy fleet pays a retirement debt within seconds, so one older than 15 minutes means a
    # silent node. The branch reads four of five minute samples, like the readiness rules.
    "SFU_RETIREMENT_DEBT_MAX_AGE_SECONDS": "900",
    # Failed TURN mints leave clients on UDP-blocked networks without media. One failed mint is a
    # blip, so page on three failed mints (either provider) in five minutes.
    "TURN_MINT_FAILURES_IN_5M": "3",
    # A sustained refusal means live calls cannot leave a lost node. Callers retry, so sustained
    # means refusals in three distinct minutes of the last five.
    "RECOVERY_REFUSED_MINUTES_IN_5M": "3",
}


def api(method, path, payload=None):
    request = Request(
        "https://api.axiom.co" + path,
        data=None if payload is None else json.dumps(payload).encode(),
        method=method,
        headers={
            "Authorization": "Bearer " + os.environ["AXIOM_TOKEN"],
            "X-Axiom-Org-Id": os.environ["AXIOM_ORG_ID"],
            "Content-Type": "application/json",
        },
    )
    try:
        with urlopen(request, timeout=30) as response:
            return json.load(response)
    except HTTPError as error:
        # Responses can echo the token; keep them out of console logs.
        raise RuntimeError(f"Axiom {method} {path} returned HTTP {error.code}") from None
    except URLError:
        raise RuntimeError(f"Axiom {method} {path} request failed") from None


# The rules that have a query of their own, joined to the generic production-state query. A rule named here is
# evaluated over minute windows by its query, so the generic query leaves it out.
RULE_BRANCHES = (
    ("readiness.apl", ("sync-readiness", "database-unreachable", "runtime-health")),
    ("sfu-readiness.apl", ("sfu-readiness",)),
    ("sfu-retirement-debt.apl", ("sfu-retirement-debt",)),
    ("turn-credentials.apl", ()),
    ("recovery-refused.apl", ()),
    ("sfu-overflow.apl", ()),
    ("sfu-node-too-old.apl", ()),
    ("deadline-scheduler.apl", ()),
    ("fleet-controller.apl", ()),
)

# What a monitor is compared on by --check.
COMPARED_FIELDS = (
    "description", "type", "aplQuery", "columnName", "operator", "threshold", "intervalMinutes", "rangeMinutes",
    "triggerFromNRuns", "triggerAfterNPositiveResults", "notifyByGroup", "notifyEveryRun", "alertOnNoData", "disabled",
)


def monitor_definitions(variables, disabled=False, without_connection_reports=False):
    monitors = json.loads(Path(__file__).with_name("monitors.json").read_text())
    branches = {
        "RULE_BRANCHES": "".join(" | union (\n" + Path(__file__).with_name(file).read_text() + "\n)" for file, _ in RULE_BRANCHES),
        "WINDOWED_RULES_EXCLUDED": "".join(f" and chalk_alert_rule != '{rule}'" for _, rules in RULE_BRANCHES for rule in rules),
    }
    branch = ""
    if not without_connection_reports:
        query = Path(__file__).with_name("connection-reports.apl").read_text()
        branch = " | union (\n" + query + "\n) | summarize value=max(value) by alert_message"
    for monitor in monitors:
        for name, branch_query in branches.items():
            monitor["aplQuery"] = monitor["aplQuery"].replace("${" + name + "}", branch_query)
        monitor["aplQuery"] = monitor["aplQuery"].replace("${CONNECTION_REPORT_BRANCH}", branch)
        for key, value in {**variables, **THRESHOLDS}.items():
            monitor["aplQuery"] = monitor["aplQuery"].replace("${" + key + "}", value)
        if "${" in monitor["aplQuery"]:
            raise RuntimeError(monitor["name"] + " has an unresolved placeholder")
        monitor["disabled"] = disabled
    return monitors


def monitor_drift(expected, live):
    """Every way the live monitors differ from the repo, as readable lines; none means they match.

    The query text is compared with its whitespace collapsed and is never printed. A monitor has no notifier, so any
    attached notifier is drift."""
    problems = []
    live_by_name = {item["name"]: item for item in live}
    for monitor in expected:
        item = live_by_name.get(monitor["name"])
        if item is None:
            problems.append(f"{monitor['name']}: missing")
            continue
        for field in COMPARED_FIELDS:
            want, have = monitor[field], item.get(field)
            if isinstance(want, bool):
                have = bool(have)
            if field == "aplQuery":
                want, have = " ".join(want.split()), " ".join((have or "").split())
            if want != have:
                problems.append(f"{monitor['name']}: {field} differs")
        if item.get("notifierIds"):
            problems.append(f"{monitor['name']}: a notifier is attached")
    return problems


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="Create/update production configuration")
    parser.add_argument("--check", action="store_true", help="Read the live monitors and exit 1 if any differs from this folder; changes nothing")
    parser.add_argument("--disabled", action="store_true", help="Stage monitors without evaluating")
    parser.add_argument("--without-connection-reports", action="store_true", help="Undo the connection-report rules without disabling existing alerts")
    args = parser.parse_args()
    variables = {}
    for name in ("LOG_DATASET", "TRACE_DATASET"):
        value = os.environ.get(name, "")
        if not re.fullmatch(r"[A-Za-z0-9_-]+", value):
            raise RuntimeError(f"{name} must be a private dataset name")
        variables[name] = value
    monitors = monitor_definitions(variables, args.disabled, args.without_connection_reports)
    if args.check:
        for name in ("AXIOM_TOKEN", "AXIOM_ORG_ID"):
            if not os.environ.get(name):
                raise RuntimeError(f"{name} is required")
        problems = monitor_drift(monitors, api("GET", "/v2/monitors"))
        for problem in problems:
            print("DRIFT " + problem, file=sys.stderr)
        if problems:
            sys.exit(1)
        print(f"The {len(monitors)} live monitors match this folder")
        return
    if not args.apply:
        print(f"Validated {len(monitors)} monitor definitions; no production changes")
        return
    for name in ("AXIOM_TOKEN", "AXIOM_ORG_ID"):
        if not os.environ.get(name):
            raise RuntimeError(f"{name} is required")
    existing_monitors = {item["name"]: item for item in api("GET", "/v2/monitors")}
    for monitor in monitors:
        existing = existing_monitors.get(monitor["name"])
        monitor["notifierIds"] = []
        api("POST" if existing is None else "PUT", "/v2/monitors" + ("" if existing is None else "/" + existing["id"]), monitor)
        print("Reconciled " + monitor["name"] + (" (disabled)" if args.disabled else ""))


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, KeyError, ValueError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
