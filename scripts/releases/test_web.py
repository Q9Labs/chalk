"""Pages rollback must be idempotent and verify the live deployment."""
import unittest
from unittest.mock import patch

import web


def deployment(identifier):
    return {'canonical_deployment': {'id': identifier, 'environment': 'production',
                                     'latest_stage': {'status': 'success'}}}


class PagesRollback(unittest.TestCase):
    def test_already_live_does_not_restore(self):
        with patch.object(web, 'pages', side_effect=[deployment('saved'), deployment('saved')]) as api, patch.object(web, 'outputs'):
            web.rollback('example', 'saved')
        self.assertEqual([call.args for call in api.call_args_list], [('example',), ('example',)])

    def test_restore_reads_before_and_verifies_after(self):
        with patch.object(web, 'pages', side_effect=[deployment('old'), {'id': 'saved'}, deployment('saved')]) as api, patch.object(web, 'outputs'):
            web.rollback('example', 'saved')
        self.assertEqual([call.args for call in api.call_args_list],
                         [('example',), ('example', '/deployments/saved/rollback', 'POST'), ('example',)])

    def test_failed_verification_refuses_success(self):
        with patch.object(web, 'pages', side_effect=[deployment('old'), {'id': 'saved'}, deployment('old')]), patch.object(web, 'outputs') as outputs:
            with self.assertRaisesRegex(ValueError, 'verification failed: saved deployment is not live'):
                web.rollback('example', 'saved')
        outputs.assert_not_called()


if __name__ == '__main__':
    unittest.main()
