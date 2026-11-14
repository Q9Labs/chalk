"""Live-call guard and quiet window: the rules that keep a release from restarting production during calls.

Promote runs this file as the `live-calls` job; release.py uses its window and count for automatic promotion."""
import json
import os
import sys
import time
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

@dataclass(frozen=True)
class Quiet:
    """No participant holds an unexpired presence lease."""


@dataclass(frozen=True)
class Busy:
    """At least one participant is in a call. The count is usage data and these logs are public, so it never leaves read_live_calls."""


@dataclass(frozen=True)
class Unknown:
    """The count could not be read. A release treats it as busy, never as zero."""
    reason: str


# Promote waits this long for calls to end. A waiting Promote holds the production lock, so a hotfix or rollback
# queues behind it: 20 minutes outlasts most calls and the 2-minute lease lapse, and still stops a stuck wait.
LIVE_CALL_WAIT_MINUTES = 20


# A deploy starts this long after the guard passes: runner queues and the gate check took about 4 minutes in
# Promote on 14 November 2026, and 15 leaves room for three times that.
DEPLOY_MARGIN_MINUTES = 15


class NoRedirect(urllib.request.HTTPRedirectHandler):
    """The operator token goes only to the URL it was given."""

    def redirect_request(self, *args, **kwargs):
        return None


def fetch_readiness(url, token):
    request = urllib.request.Request(url, headers={'User-Agent': 'chalk-release', 'Authorization': f'Bearer {token}'})
    return urllib.request.build_opener(NoRedirect).open(request, timeout=15).read()


def read_live_calls(api_url, token, fetch=fetch_readiness):
    """Read the live participant count that the production API shows an operator on /readyz. Only whether anyone is in a call leaves this function."""
    if not api_url.startswith('https://') or not token:
        return Unknown('the API URL or the operator read token is missing')
    try:
        count = json.loads(fetch(api_url.rstrip('/') + '/readyz', token)).get('live_participants')
    except (OSError, ValueError, AttributeError) as error:
        return Unknown(f'the API did not answer with a readiness body ({type(error).__name__})')
    if isinstance(count, bool) or not isinstance(count, int) or count < 0:
        return Unknown('the API does not report live_participants (it predates the field, or it does not accept the token)')
    return Busy() if count else Quiet()


def describe(result):
    if isinstance(result, Quiet):
        return 'no live calls'
    if isinstance(result, Busy):
        return 'participants are in live calls'
    return f'live calls unknown: {result.reason}'


def await_quiet(read, sleep, *, wait_minutes=LIVE_CALL_WAIT_MINUTES, allow_live_calls=False, say=print,
                deadline=None, now=lambda: datetime.now(timezone.utc)):
    """Return when no live call runs. Raise when calls last past the wait, the count cannot be read (unless a person
    allowed it) or the deadline, the end of an automatic release's quiet window, has passed."""
    def require_open():
        if deadline and now() >= deadline:
            raise ValueError(f'too late to deploy inside the quiet window: the guard refuses from {deadline:%H:%M}Z; the next quiet-window tick tries again')

    for minute in range(wait_minutes + 1):
        require_open()
        result = read()
        require_open()  # A slow read must not turn a closed window into an approval.
        if isinstance(result, Quiet):
            say('No live calls. Continuing.')
            return
        if allow_live_calls:
            say(f'allow_live_calls=true: continuing with {describe(result)}.')
            return
        if minute == wait_minutes:
            break
        say(f'Waiting for calls to end ({describe(result)}); minute {minute} of {wait_minutes}.')
        sleep(60)
    raise ValueError(f'{describe(result)} after waiting {wait_minutes} minutes. Run Promote again when calls have ended, '
                     'or set allow_live_calls to deploy anyway.')


# Auto-promote deploys only while few people call: 21:00 to 01:00 UTC is 01:00 to 05:00 in Dubai.
QUIET_FROM_HOUR_UTC = 21
QUIET_UNTIL_HOUR_UTC = 1


def now():
    return datetime.now(timezone.utc)


def in_window(at):
    return at.hour >= QUIET_FROM_HOUR_UTC or at.hour < QUIET_UNTIL_HOUR_UTC


def window_end(at):
    end = at.replace(hour=QUIET_UNTIL_HOUR_UTC, minute=0, second=0, microsecond=0)
    return end if at.hour < QUIET_UNTIL_HOUR_UTC else end + timedelta(days=1)


def read_configured():
    return read_live_calls(os.environ.get('LIVE_CALLS_API_URL', ''), os.environ.get('LIVE_CALLS_API_TOKEN', ''))


def last_start(deploy_before):
    """The guard refuses from here: a deploy that starts later could finish starting after deploy_before."""
    return deploy_before - timedelta(minutes=DEPLOY_MARGIN_MINUTES)


def require_quiet_window():
    """Auto-promote deploys only inside the window and only while no call runs. Returns the end of the window it
    started in, fixed before the read, so a slow read cannot pass into the next day's window."""
    start = now()
    if not in_window(start):
        raise ValueError(f'{start:%H:%M}Z is outside the quiet window ({QUIET_FROM_HOUR_UTC}:00 to 0{QUIET_UNTIL_HOUR_UTC}:00Z); '
                         'a quiet-window tick promotes the held cut')
    end = window_end(start)
    calls = read_configured()
    if not isinstance(calls, Quiet):
        raise ValueError(f'{describe(calls)}; a quiet-window tick tries again')
    if now() >= last_start(end):
        raise ValueError(f'too late to dispatch inside the quiet window: the guard refuses from {last_start(end):%H:%M}Z; the next quiet-window tick tries again')
    return end


def main():
    try:
        deploy_before = os.environ.get('DEPLOY_BEFORE')
        await_quiet(read_configured, time.sleep, allow_live_calls=os.environ.get('ALLOW_LIVE_CALLS') == 'true',
                    deadline=last_start(datetime.fromisoformat(deploy_before)) if deploy_before else None)
    except ValueError as error:
        sys.exit(f'Release refused: {error}')


if __name__ == '__main__':
    main()
