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
        self.assertIn('total wait', text.split('Path to')[1])


if __name__ == '__main__':
    unittest.main()
