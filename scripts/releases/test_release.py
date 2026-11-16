"""Tests for the direct Sync URL in release configuration."""
import os
import unittest
from pathlib import Path
from unittest.mock import patch

import web
from test_support import SHA

class WebDirectSyncConfigTests(unittest.TestCase):
    """The direct Sync URL reaches the web build only when the release environment sets it."""

    def config(self, **environment):
        with patch.dict(os.environ):
            os.environ.pop('CHALK_WEB_SYNC_DIRECT_URL', None)
            os.environ.update(environment)
            return web.public_config('nightly', SHA)

    def test_unset_keeps_the_public_config_unchanged(self):
        self.assertNotIn('VITE_CHALK_SYNC_DIRECT_URL', self.config())
        self.assertEqual(self.config(CHALK_WEB_SYNC_DIRECT_URL='  '), self.config())

    def test_a_direct_url_is_passed_to_the_build(self):
        url = 'wss://direct.example.test/v1/sync'
        self.assertEqual(self.config(CHALK_WEB_SYNC_DIRECT_URL=url)['VITE_CHALK_SYNC_DIRECT_URL'], url)

    def test_a_production_build_refuses_a_direct_url(self):
        with patch.dict(os.environ, CHALK_WEB_SYNC_DIRECT_URL='wss://direct.example.test/v1/sync'):
            with self.assertRaises(ValueError):
                web.public_config('production', SHA)
        with patch.dict(os.environ):
            os.environ.pop('CHALK_WEB_SYNC_DIRECT_URL', None)
            self.assertNotIn('VITE_CHALK_SYNC_DIRECT_URL', web.public_config('production', SHA))

    def test_a_production_bundle_that_names_a_direct_host_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            client = Path(directory)
            (client / 'assets').mkdir()
            (client / 'assets/app.js').write_text('connect("wss://sync.chalkmeet.com/v1/sync")')
            web.reject_direct_sync_url(client)
            (client / 'assets/leak.js').write_text('connect("wss://nightly-sync-direct.chalkmeet.com/v1/sync")')
            with self.assertRaises(ValueError):
                web.reject_direct_sync_url(client)

    def test_a_malformed_direct_url_fails_the_release(self):
        for url in ('ws://direct.example.test/v1/sync', 'wss://direct.example.test/other', 'wss://direct.example.test/v1/sync?x=1', 'direct.example.test'):
            with self.subTest(url=url), self.assertRaises(ValueError):
                self.config(CHALK_WEB_SYNC_DIRECT_URL=url)
