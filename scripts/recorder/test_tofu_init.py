"""tofu-init.sh recovers from a provider download that fails for a moment and gives up after a bounded number of tries."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).with_name('tofu-init.sh')
DOWNLOAD_ERROR = 'Error while installing digitalocean/digitalocean v2.95.0: github.com: GET giving up after 3 attempt(s)'


def run_init(failures):
    """Runs the script against a tofu stub that fails `failures` times with the observed error, then succeeds."""
    with tempfile.TemporaryDirectory() as directory:
        counter = Path(directory, 'calls')
        stub = Path(directory, 'tofu')
        stub.write_text(
            '#!/bin/sh\n'
            f'echo x >> "{counter}"\n'
            f'if [ "$(wc -l < "{counter}")" -le {failures} ]; then echo "{DOWNLOAD_ERROR}" >&2; exit 1; fi\n')
        stub.chmod(0o700)
        env = dict(os.environ, PATH=directory + os.pathsep + os.environ['PATH'], TOFU_INIT_DELAYS='0.01 0.01 0')
        result = subprocess.run(['bash', str(SCRIPT), 'infrastructure/recorder'], env=env, capture_output=True, text=True)
        return result, len(counter.read_text().splitlines())


class TofuInit(unittest.TestCase):
    def test_recovers_after_a_failed_provider_download(self):
        result, calls = run_init(failures=2)
        self.assertEqual((result.returncode, calls), (0, 3), result.stderr)

    def test_gives_up_after_three_attempts(self):
        result, calls = run_init(failures=99)
        self.assertEqual((result.returncode, calls), (1, 3))
        self.assertIn('failed in infrastructure/recorder after 3 attempts', result.stderr)


if __name__ == '__main__':
    unittest.main()
