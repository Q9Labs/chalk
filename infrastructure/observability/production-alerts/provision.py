#!/usr/bin/env python3
"""Reconcile only the three named Chalk monitors and their Discord notifier."""

import argparse
import json
import os
from pathlib import Path
import re
import sys
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="Create/update production configuration")
    parser.add_argument("--disabled", action="store_true", help="Stage monitors without evaluating or notifying")
    args = parser.parse_args()
    variables = {}
    for name in ("LOG_DATASET", "TRACE_DATASET"):
        value = os.environ.get(name, "")
        if not re.fullmatch(r"[A-Za-z0-9_-]+", value):
            raise RuntimeError(f"{name} must be a private dataset name")
        variables[name] = value
    monitors = json.loads(Path(__file__).with_name("monitors.json").read_text())
    for monitor in monitors:
        for key, value in variables.items():
            monitor["aplQuery"] = monitor["aplQuery"].replace("${" + key + "}", value)
        monitor["disabled"] = args.disabled
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
        notifiers = api("GET", "/v2/notifiers")
        existing = next((item for item in notifiers if item["name"] == "Chalk production Discord"), None)
        payload = {"name": "Chalk production Discord", "properties": {"customWebhook": {"url": webhook, "body": Path(__file__).with_name("discord-body.tmpl").read_text()}}}
        notifier = api("POST" if existing is None else "PUT", "/v2/notifiers" + ("" if existing is None else "/" + existing["id"]), payload)
        notifier_ids = [notifier["id"]]
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
