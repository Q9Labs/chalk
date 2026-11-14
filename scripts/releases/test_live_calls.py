import os
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import Mock, patch

import live_calls
import release
from github_release import GitHub


def at(hour, minute=0, second=0, day=15):
    return datetime(2026, 11, day, hour, minute, second, tzinfo=timezone.utc)


class LiveCallsTests(unittest.TestCase):
    def read(self, body):
        return live_calls.read_live_calls('https://api.example/', 'secret-token', lambda url, token: body if url.endswith('/readyz') and token == 'secret-token' else b'')

    def test_the_count_is_read_from_the_readiness_body_and_never_defaults_to_zero(self):
        self.assertEqual(self.read(b'{"live_participants": 0}'), live_calls.Quiet())
        self.assertEqual(self.read(b'{"live_participants": 3}'), live_calls.Busy(3))
        for body in (b'{}', b'{"live_participants": -1}', b'{"live_participants": true}', b'{"live_participants": "0"}', b'[]', b'not json'):
            with self.subTest(body=body):
                self.assertIsInstance(self.read(body), live_calls.Unknown)

        def refuse(url, token):
            raise OSError('connection refused')
        self.assertIsInstance(live_calls.read_live_calls('https://api.example', 'secret-token', refuse), live_calls.Unknown)
        for url, token in (('', 'secret-token'), ('http://api.example', 'secret-token'), ('https://api.example', '')):
            with self.subTest(url=url, token=bool(token)):
                self.assertIsInstance(live_calls.read_live_calls(url, token, lambda url, token: b'{"live_participants": 0}'), live_calls.Unknown)

    def test_the_unknown_reason_never_carries_the_token_or_the_url(self):
        def refuse(url, token):
            raise OSError(f'cannot reach {url} with {token}')
        reason = live_calls.read_live_calls('https://api.example', 'secret-token', refuse).reason
        self.assertNotIn('secret-token', reason)
        self.assertNotIn('api.example', reason)

    def await_quiet(self, readings, **options):
        remaining, naps, said = list(readings), [], []
        live_calls.await_quiet(lambda: remaining.pop(0) if len(remaining) > 1 else remaining[0], naps.append, say=said.append, **options)
        return naps, said

    def test_promote_deploys_at_once_when_no_call_runs_and_waits_for_calls_to_end(self):
        self.assertEqual(self.await_quiet([live_calls.Quiet()])[0], [])
        naps, said = self.await_quiet([live_calls.Busy(5), live_calls.Busy(2), live_calls.Quiet()])
        self.assertEqual(naps, [60, 60])
        self.assertEqual(said[-1], 'No live calls. Continuing.')

    def test_promote_refuses_when_calls_outlast_the_wait_and_prints_only_the_count(self):
        naps, said = [], []
        with self.assertRaises(ValueError) as error:
            live_calls.await_quiet(lambda: live_calls.Busy(4), naps.append, wait_minutes=3, say=said.append)
        self.assertEqual(naps, [60, 60, 60])
        self.assertIn('4 participant(s) in live calls after waiting 3 minutes', str(error.exception))
        self.assertIn('allow_live_calls', str(error.exception))

    def test_promote_treats_an_unreadable_count_as_busy_and_a_person_can_allow_it(self):
        with self.assertRaises(ValueError) as error:
            live_calls.await_quiet(lambda: live_calls.Unknown('no answer'), lambda seconds: None, wait_minutes=2, say=lambda line: None)
        self.assertIn('live calls unknown: no answer', str(error.exception))
        for reading in (live_calls.Busy(7), live_calls.Unknown('no answer')):
            naps, said = self.await_quiet([reading], allow_live_calls=True)
            self.assertEqual(naps, [])
            self.assertTrue(said[0].startswith('allow_live_calls=true: continuing with '))

    def test_promote_refuses_once_the_quiet_window_has_closed(self):
        clock = iter([at(0, 59, day=16)] * 2 + [at(1, 5, day=16)])
        naps = []
        with self.assertRaises(ValueError) as error:
            live_calls.await_quiet(lambda: live_calls.Busy(1), naps.append, deadline=at(1, day=16), now=lambda: next(clock), say=lambda line: None)
        self.assertEqual(naps, [60])
        self.assertIn('too late to deploy inside the quiet window', str(error.exception))

    def test_the_guard_refuses_from_fifteen_minutes_before_the_end_of_the_window(self):
        limit = live_calls.last_start('2026-11-16T01:00:00+00:00')
        self.assertEqual(limit, at(0, 45, day=16))
        for now, passes in ((at(0, 44, 59, day=16), True), (at(0, 45, day=16), False), (at(0, 59, day=16), False)):
            with self.subTest(now=f'{now:%H:%M:%S}'):
                try:
                    live_calls.await_quiet(lambda: live_calls.Quiet(), lambda seconds: None, now=lambda: now, say=lambda line: None, deadline=limit)
                except ValueError:
                    self.assertFalse(passes)
                else:
                    self.assertTrue(passes)

    def test_a_quiet_read_that_ends_after_the_window_closed_does_not_approve(self):
        clock = iter([at(0, 59, 59, day=16), at(1, 0, 1, day=16)])
        with self.assertRaises(ValueError):
            live_calls.await_quiet(lambda: live_calls.Quiet(), lambda seconds: None, now=lambda: next(clock), say=lambda line: None,
                                   deadline=at(1, day=16))


class AutoPromoteWindowTests(unittest.TestCase):
    """Automatic promotion names a SHA only inside the quiet window and only while no call runs."""

    def promoted(self, now, calls=live_calls.Quiet()):
        directory = self.enterContext(tempfile.TemporaryDirectory())
        output = Path(directory) / 'output'
        self.enterContext(patch.dict(os.environ, GITHUB_OUTPUT=str(output), GITHUB_STEP_SUMMARY=str(Path(directory) / 'summary')))
        self.enterContext(patch.object(live_calls, 'now', return_value=now))
        self.enterContext(patch.object(live_calls, 'read_configured', return_value=calls))
        self.enterContext(patch.object(release, 'choose', return_value=dict(selection=dict(target_sha='a' * 40), previous=dict(target_sha='b' * 40))))
        release.auto_promote(Mock(spec=GitHub), None)
        return dict(line.split('=', 1) for line in output.read_text().splitlines())

    def test_it_waits_for_the_quiet_window(self):
        for now, promotes in ((at(20, 59), False), (at(21), True), (at(23, 59), True), (at(0, 59, day=16), True),
                              (at(1, day=16), False), (at(12), False)):
            with self.subTest(now=f'{now:%H:%M}'):
                self.assertEqual(self.promoted(now)['sha'], 'a' * 40 if promotes else '')

    def test_it_holds_while_calls_run_or_the_count_is_unknown(self):
        for calls in (live_calls.Busy(2), live_calls.Unknown('no answer')):
            with self.subTest(calls=calls):
                self.assertEqual(self.promoted(at(22, 5), calls)['sha'], '')

    def test_it_hands_promote_the_end_of_the_window(self):
        self.assertEqual(self.promoted(at(22, 5))['until'], '2026-11-16T01:00:00+00:00')
        self.assertEqual(self.promoted(at(0, 5, day=16))['until'], '2026-11-16T01:00:00+00:00')


if __name__ == '__main__':
    unittest.main()
