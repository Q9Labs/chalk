"""Phase-aware decisions for a release observer; no deployment side effects."""


def ready(sample):
    return sample.get("http") == 200 and sample.get("body", {}).get("status") in ("ok", "ready")


def confirmed_readiness_failures(snapshot, at, events=(), since=None):
    """Count HTTP failures, or fresh connection failures on both independent networks."""
    latest = {}
    for event in events:
        if event.get("type") != "public-status" or event.get("network") not in ("air", "instabox"):
            continue
        timestamp = event.get("timestamp", -1)
        if timestamp <= at and at - timestamp <= 30:
            network = event["network"]
            if network not in latest or timestamp > latest[network]["timestamp"]:
                latest[network] = event
    failures = {}
    for service in ("api", "sync"):
        host = snapshot.get(service, {})
        failed = host.get("http") is not None and not ready(host)
        fresh = [event for event in latest.values() if since is None or event["timestamp"] > since]
        failed = failed or any(event.get(service, {}).get("http") is not None and not ready(event[service]) for event in fresh)
        connections = [event for event in fresh if service in event and event[service].get("http") is None]
        failed = failed or len(connections) == 2
        failures[service] = failed
    return failures


class ReleaseWatch:
    def __init__(self, manifest):
        self.manifest = manifest
        self.ssm_started_at = None
        self.stopped_at = None
        self.watch_started_at = None
        self.last_readiness_check = None
        self.failures = {"api": 0, "sync": 0}

    @property
    def phase(self):
        if self.watch_started_at is not None:
            return "watch"
        return "swap" if self.ssm_started_at is not None else "baseline"

    def evaluate(self, snapshot, at, *, ssm_started_at=None, stopped_at=None, web_ready=True, events=()):
        if ssm_started_at is not None:
            self.ssm_started_at = ssm_started_at
        if stopped_at is not None:
            self.stopped_at = stopped_at
        services_ready = all(ready(snapshot.get(name, {})) for name in self.failures)
        confirmed = confirmed_readiness_failures(snapshot, at, events, self.last_readiness_check)
        revisions = snapshot.get("component_releases", {})
        containers = snapshot.get("containers", {})
        candidate_live = snapshot.get("release_id") == self.manifest["release_id"] and all(
            revisions.get(name) == self.manifest["component_releases"][name]
            and containers.get("chalk-" + name, {}).get("revision") == self.manifest["component_releases"][name]["source_revision"]
            and containers.get("chalk-" + name, {}).get("image") == self.manifest["images"][name]
            for name in self.failures
        )
        if self.phase == "swap" and self.stopped_at is not None and self.stopped_at >= self.ssm_started_at and candidate_live and services_ready and web_ready and not any(confirmed.values()):
            self.watch_started_at = at
            self.failures = dict.fromkeys(self.failures, 0)
        hold, rollback = [], []
        if self.phase == "baseline":
            if not services_ready:
                hold.append("baseline release is not ready")
            if any(event.get("type") == "checkpoint" and event.get("pass") is False for event in events):
                hold.append("baseline two-person call failed")
        elif self.phase == "swap":
            if self.stopped_at is not None and at - self.stopped_at > 120 and any(confirmed.values()):
                rollback.append("no ready release more than 120 seconds after deliberate stop")
        else:
            if self.last_readiness_check is None or at - self.last_readiness_check >= 30:
                self.last_readiness_check = at
                for name in self.failures:
                    self.failures[name] = self.failures[name] + 1 if confirmed[name] else 0
                    if self.failures[name] >= 2:
                        rollback.append(name + " failed two consecutive 30-second checks")
            if any(event.get("type") == "checkpoint" and event.get("pass") is False and event.get("timestamp", 0) >= self.watch_started_at for event in events):
                rollback.append("two-person call failed during watch")
        return {"phase": self.phase, "hold": hold, "rollback": rollback, "watch_started_at": self.watch_started_at}
