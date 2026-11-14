import json
import unittest

from github_release import payload


class PayloadTests(unittest.TestCase):
    def test_a_record_cut_before_the_rename_still_carries_its_chalk_sfu_verdict(self):
        legacy = dict(channel='nightly-cut', own_sfu_proof_result='passed')
        self.assertEqual(payload(dict(payload=json.dumps(legacy))),
                         dict(channel='nightly-cut', chalk_sfu_proof_result='passed'))


if __name__ == '__main__':
    unittest.main()
