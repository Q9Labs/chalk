"""Provider diagnostics expose fixed error classes, never provider payloads."""
import subprocess
import unittest
from unittest.mock import patch

from release_io import Provider


class TofuErrors(unittest.TestCase):
    def test_failure_reports_only_fixed_class_and_exit_status(self):
        for diagnostic, label in [('Error acquiring the state lock', 'state-lock'),
                                  ('ExpiredToken', 'authentication'), ('AccessDenied', 'authorization'),
                                  ('Unsupported argument', 'configuration'), ('no such host', 'network'),
                                  ('unexpected failure', 'unclassified')]:
            with self.subTest(label=label):
                result = subprocess.CompletedProcess([], 1, 'secret-output', diagnostic + ' secret-token private-resource-id')
                with patch('release_io.subprocess.run', return_value=result):
                    with self.assertRaises(RuntimeError) as error:
                        Provider('example', None).command(['tofu', '-chdir=private-path', 'apply'])
                self.assertEqual(str(error.exception), f'tofu operation failed (exit 1); error class: {label}; no payload logged')


if __name__ == '__main__':
    unittest.main()
