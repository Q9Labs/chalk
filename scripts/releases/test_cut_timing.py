import json
import unittest
from pathlib import Path

import cut_timing

# Cut 43358933721, dispatched 03:26:06Z: the jobs as they stood while its proof was still queued.
SAVED = json.loads((Path(__file__).parent / 'fixtures/cut_jobs.json').read_text())
STARTED = SAVED['run']['run_started_at']


class CutTimingTests(unittest.TestCase):
    def rows(self):
        return cut_timing.timings(cut_timing.moment(STARTED), SAVED['jobs'])

    def test_a_job_splits_into_its_wait_for_a_runner_and_its_work(self):
        gate = next(row for row in self.rows() if row['name'] == 'release / Require a green master Gate')
        self.assertAlmostEqual(gate['wait'], 19.7, delta=0.1)
        self.assertAlmostEqual(gate['work'], 0.1, delta=0.1)

    def test_a_job_still_queued_has_no_row(self):
        self.assertNotIn('proof / Real-call proofs', [row['name'] for row in self.rows()])

    def test_the_path_to_the_web_deploy_runs_through_the_media_build_not_the_image_builds(self):
        path = cut_timing.critical_path(self.rows(), 'Deploy selected web')
        self.assertEqual([row['name'].removeprefix('release / ') for row in path], [
            'plan', 'Require a green master Gate', 'Plan managed components', 'Build immutable media release archives',
            'Publish managed release manifest', 'Verify source and prepare deployment envelope', 'Deploy managed release to nightly',
            'Deploy selected web or restore Pages'])
        self.assertAlmostEqual(path[-1]['end'], 115.5, delta=0.1)

    def test_a_name_that_matches_no_finished_job_is_refused(self):
        with self.assertRaisesRegex(ValueError, 'no finished job'):
            cut_timing.critical_path(self.rows(), 'record')

    def test_the_report_totals_the_path(self):
        text = cut_timing.report(STARTED, SAVED['jobs'], 'Deploy selected web')
        self.assertIn('total wait 96.2, total work 19.3', text)

    def test_a_job_that_ended_after_another_was_created_never_released_it(self):
        def job(name, created, started, ended):
            return dict(name=name, created_at=created, started_at=started, completed_at=ended)
        jobs = [job('a', '2026-11-13T00:00:00Z', '2026-11-13T00:00:00Z', '2026-11-13T00:00:10Z'),
                job('b', '2026-11-13T00:00:00Z', '2026-11-13T00:00:00Z', '2026-11-13T00:00:11Z'),
                job('c', '2026-11-13T00:00:10Z', '2026-11-13T00:00:10Z', '2026-11-13T00:00:20Z')]
        rows = cut_timing.timings(cut_timing.moment('2026-11-13T00:00:00Z'), jobs)
        self.assertEqual([row['name'] for row in cut_timing.critical_path(rows, 'c')], ['a', 'c'])

    def test_the_walk_ends_when_two_jobs_follow_each_other_closely(self):
        jobs = [dict(name='a', created_at='2026-11-13T00:00:00Z', started_at='2026-11-13T00:00:00Z', completed_at='2026-11-13T00:00:01Z'),
                dict(name='b', created_at='2026-11-13T00:00:01Z', started_at='2026-11-13T00:00:01Z', completed_at='2026-11-13T00:00:02Z')]
        rows = cut_timing.timings(cut_timing.moment('2026-11-13T00:00:00Z'), jobs)
        self.assertEqual([row['name'] for row in cut_timing.critical_path(rows, 'b')], ['a', 'b'])


if __name__ == '__main__':
    unittest.main()
