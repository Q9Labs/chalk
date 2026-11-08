import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


spec = importlib.util.spec_from_file_location('boot_check_host', Path(__file__).with_name('boot-check-host.py'))
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)


class IssuerReadinessTest(unittest.TestCase):
    def run_registration(self, unavailable=None):
        now = [0]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            environment = {
                'CHALK_RECORDER_FLEET_ISSUER_STATE_PATH': '/issuer.json',
                'CHALK_RECORDER_FLEET_ISSUER_WORKER_CA_CERT': '/ca.pem',
                'CHALK_RECORDER_FLEET_ISSUER_SPIFFE_TRUST_DOMAIN': 'chalk',
            }
            (root / 'issuer.json').write_text(json.dumps({'registrations': {'node': {'certificates': ['certificate']}}}))
            (root / 'ca.pem').write_text('ca')

            def inspect(args, **kwargs):
                issuer = args[-1] == 'chalk-recorder-issuer'
                if unavailable:
                    phase = unavailable
                elif now[0] < 3:
                    phase = 'missing'
                elif now[0] < 4:
                    phase = 'stopped'
                elif now[0] < 5:
                    phase = 'files'
                else:
                    phase = 'ready'
                if issuer and phase == 'missing':
                    # The failed SSM registration trace ended at runtime's Config
                    # lookup. Generic inspect can resolve the same-named volume.
                    if 'container' not in args:
                        return json.dumps([{'Name': 'chalk-recorder-issuer', 'Mountpoint': '/volume'}])
                    raise subprocess.CalledProcessError(125, args, stderr='no such container')
                running = not issuer or phase != 'stopped'
                pid = 123 if running else 0
                return json.dumps([{'Config': {'Env': [key + '=' + value for key, value in environment.items()]},
                                    'State': {'Running': running, 'Pid': pid}}])

            def read(path, *args, **kwargs):
                if unavailable == 'files' or now[0] < 5:
                    raise FileNotFoundError('issuer container root changed')
                return original_read(root / path.name, *args, **kwargs)

            def sleep(seconds):
                now[0] += seconds

            original_read = Path.read_text
            with patch.object(host.subprocess, 'check_output', side_effect=inspect), \
                    patch.object(Path, 'read_text', read), \
                    patch.object(host.time, 'monotonic', side_effect=lambda: now[0]), \
                    patch.object(host.time, 'sleep', side_effect=sleep), \
                    patch.object(host, 'control', return_value={'status': 200}):
                try:
                    result = host.execute({'action': 'register', 'role': 'capture', 'user_id': 1000,
                                           'timeout': 7, 'bootstrap': {'provider_id': 'node'}})
                except RuntimeError as error:
                    return error, now[0]
                return result, now[0]

    def test_issuer_recreation_waits_for_container_and_readable_files(self):
        result, elapsed = self.run_registration()
        self.assertEqual(result['record'], {'certificates': ['certificate']})
        self.assertEqual(result['controller_response']['status'], 200)
        self.assertEqual(elapsed, 5)

    def test_unready_issuer_stops_at_registration_deadline(self):
        for state in ('missing', 'stopped', 'files'):
            with self.subTest(state=state):
                result, elapsed = self.run_registration(state)
                self.assertIsInstance(result, RuntimeError)
                self.assertEqual(elapsed, 7)
                self.assertIn('deadline', str(result))


if __name__ == '__main__':
    unittest.main()
