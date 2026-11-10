import unittest

import provision

ONCALL = {"id": "n2", "name": provision.ONCALL_NOTIFIER}
OTHER = {"id": "n1", "name": "Chalk production Discord"}


class KeptOncallIds(unittest.TestCase):
    def test_apply_without_the_url_keeps_an_existing_oncall_notifier(self):
        self.assertEqual(provision.kept_oncall_ids([OTHER, ONCALL], detach=False), ["n2"])

    def test_no_oncall_notifier_means_none_attached(self):
        self.assertEqual(provision.kept_oncall_ids([OTHER], detach=False), [])

    def test_detach_removes_it_on_request_only(self):
        self.assertEqual(provision.kept_oncall_ids([OTHER, ONCALL], detach=True), [])


if __name__ == "__main__":
    unittest.main()
