"""Provider diagnostics cross the real process boundary without leaking payloads."""
import contextlib
import io
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from release_io import Provider


class TofuErrors(unittest.TestCase):
    def test_failure_reports_only_fixed_class_and_exit_status(self):
        with tempfile.TemporaryDirectory() as directory:
            executable = Path(directory, 'tofu')
            executable.write_text(f'#!{sys.executable}\nimport os, sys\nprint("sentinel-stdout-secret")\nprint(os.environ["TOFU_DIAGNOSTIC"] + " sentinel-token private-resource-id", file=sys.stderr)\nsys.exit(7)\n')
            executable.chmod(0o700)
            for diagnostic, label in [('Error acquiring the state lock', 'state-lock'),
                                      ('ExpiredToken', 'authentication'), ('AccessDenied', 'authorization'),
                                      ('Unsupported argument', 'configuration'), ('no such host', 'network'),
                                      ('unexpected failure', 'unclassified')]:
                with self.subTest(label=label), patch.dict(os.environ, PATH=directory + os.pathsep + os.environ['PATH'], TOFU_DIAGNOSTIC=diagnostic):
                    stdout, stderr = io.StringIO(), io.StringIO()
                    with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr), self.assertRaises(RuntimeError) as error:
                        Provider('example', None).command(['tofu', '-chdir=private-path', 'apply'])
                    self.assertEqual(stdout.getvalue() + stderr.getvalue(), '')
                    self.assertEqual(str(error.exception), f'tofu operation failed (exit 7); error class: {label}; no payload logged')


if __name__ == '__main__':
    unittest.main()
