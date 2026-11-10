#!/usr/bin/env python3
"""Reconcile only the three named Chalk monitors and their Discord and Oncall notifiers."""

import argparse
import json
import os
from pathlib import Path
import re
import sys
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


# Thresholds of the own-SFU rules, set only here. The APL files read them as ${NAME}.
THRESHOLDS = {
    # docs/observability.md, retirement debt: "Alert when the oldest unpaid debt is above 15 minutes
    # for 5 minutes". The branch reads four of five minute samples, like the readiness rules.
    "SFU_RETIREMENT_DEBT_MAX_AGE_SECONDS": "900",
    # docs/observability.md, TURN mint failures: "Any value above zero over a few minutes means
    # clients on UDP-blocked networks cannot connect media". One failed mint is a blip, so page on
    # three failed mints (either provider) in five minutes.
    "TURN_MINT_FAILURES_IN_5M": "3",
    # docs/observability.md, recovery: "A sustained refused_* rate means live calls cannot leave a
    # lost node". Callers retry, so sustained means refusals in three distinct minutes of the last five.
    "RECOVERY_REFUSED_MINUTES_IN_5M": "3",
}


def reconcile_notifier(name, properties):
    notifiers = api("GET", "/v2/notifiers")
    existing = next((item for item in notifiers if item["name"] == name), None)
    payload = {"name": name, "properties": properties}
    notifier = api("POST" if existing is None else "PUT", "/v2/notifiers" + ("" if existing is None else "/" + existing["id"]), payload)
    return notifier["id"]


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
        # Responses can echo the webhook/token; keep them out of console logs.
        raise RuntimeError(f"Axiom {method} {path} returned HTTP {error.code}") from None
    except URLError:
        raise RuntimeError(f"Axiom {method} {path} request failed") from None


def monitor_definitions(variables, disabled=False, without_connection_reports=False):
    monitors = json.loads(Path(__file__).with_name("monitors.json").read_text())
    branches = {
        name: " | union (\n" + Path(__file__).with_name(file).read_text() + "\n)"
        for name, file in (("SYNC_READINESS_BRANCH", "sync-readiness.apl"), ("SFU_READINESS_BRANCH", "sfu-readiness.apl"), ("SFU_RETIREMENT_DEBT_BRANCH", "sfu-retirement-debt.apl"), ("TURN_CREDENTIALS_BRANCH", "turn-credentials.apl"), ("RECOVERY_REFUSED_BRANCH", "recovery-refused.apl"), ("SFU_OVERFLOW_BRANCH", "sfu-overflow.apl"), ("DEADLINE_SCHEDULER_BRANCH", "deadline-scheduler.apl"))
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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="Create/update production configuration")
    parser.add_argument("--disabled", action="store_true", help="Stage monitors without evaluating or notifying")
    parser.add_argument("--without-connection-reports", action="store_true", help="Undo the connection-report rules without disabling existing alerts")
    args = parser.parse_args()
    variables = {}
    for name in ("LOG_DATASET", "TRACE_DATASET"):
        value = os.environ.get(name, "")
        if not re.fullmatch(r"[A-Za-z0-9_-]+", value):
            raise RuntimeError(f"{name} must be a private dataset name")
        variables[name] = value
    monitors = monitor_definitions(variables, args.disabled, args.without_connection_reports)
    if not args.apply:
        print(f"Validated {len(monitors)} monitor definitions; no production changes")
        return
    for name in ("AXIOM_TOKEN", "AXIOM_ORG_ID"):
        if not os.environ.get(name):
            raise RuntimeError(f"{name} is required")
    webhook = os.environ.get("DISCORD_WEBHOOK_URL", "")
    if not webhook and not args.disabled:
        raise RuntimeError("DISCORD_WEBHOOK_URL is required to enable monitors")
    notifier_ids = []
    if webhook:
        if not re.fullmatch(r"https://discord\.com/api/webhooks/[0-9]+/[A-Za-z0-9_-]+", webhook):
            raise RuntimeError("DISCORD_WEBHOOK_URL must be a Discord webhook URL")
        discord = {"customWebhook": {"url": webhook, "headers": {"Content-Type": "application/json"}, "body": Path(__file__).with_name("discord-body.tmpl").read_text()}}
        notifier_ids.append(reconcile_notifier("Chalk production Discord", discord))
    oncall = os.environ.get("ONCALL_WEBHOOK_URL", "")
    if oncall:
        if not re.fullmatch(r"https://[A-Za-z0-9.-]+/[A-Za-z0-9/_.~%-]+", oncall):
            raise RuntimeError("ONCALL_WEBHOOK_URL must be an https URL")
        # The plan has no custom-webhook feature to create a notifier with; the Slack notifier is free.
        notifier_ids.append(reconcile_notifier("Chalk production Oncall", {"slack": {"slackUrl": oncall}}))
    existing_monitors = {item["name"]: item for item in api("GET", "/v2/monitors")}
    for monitor in monitors:
        existing = existing_monitors.get(monitor["name"])
        monitor["notifierIds"] = notifier_ids
        api("POST" if existing is None else "PUT", "/v2/monitors" + ("" if existing is None else "/" + existing["id"]), monitor)
        print("Reconciled " + monitor["name"] + (" (disabled)" if args.disabled else ""))


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, KeyError, ValueError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
