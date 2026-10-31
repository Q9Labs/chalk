"""Scan packed npm packages for secrets before publishing."""

import json
from pathlib import Path
import secrets
import string
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SCANNER = ROOT / "scripts/releases/scan-npm-tarballs.sh"
GITLEAKS_CONFIG = ROOT / ".gitleaks.toml"


class NpmTarballScanTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)

    def pack(self, include_token=False):
        package = self.root / "package"
        output = self.root / "tarballs"
        (package / "dist").mkdir(parents=True)
        output.mkdir()
        (package / "package.json").write_text(json.dumps({
            "name": "tarball-scan-fixture",
            "version": "1.0.0",
            "files": ["dist"],
        }))
        content = "export const value = 1;\n"
        if include_token:
            token = "gh" + "p_" + "".join(secrets.choice(string.ascii_letters + string.digits) for _ in range(36))
            content = f'export const token = "{token}";\n'
        (package / "dist/index.js").write_text(content)
        result = subprocess.run(
            ["npm", "pack", "--pack-destination", str(output)],
            cwd=package,
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        tarballs = list(output.glob("*.tgz"))
        self.assertEqual(len(tarballs), 1, result.stdout)
        return output, tarballs[0]

    def scan(self, directory):
        return subprocess.run(
            ["bash", str(SCANNER), str(directory), str(GITLEAKS_CONFIG)],
            cwd=ROOT,
            capture_output=True,
            text=True,
        )

    def test_detects_a_fake_github_pat_in_a_packed_package(self):
        directory, tarball = self.pack(include_token=True)
        result = self.scan(directory)
        output = result.stdout + result.stderr
        self.assertNotEqual(result.returncode, 0, output)
        self.assertIn(tarball.name, output)
        self.assertIn("Finding:", output)

    def test_clean_packed_package_passes(self):
        directory, tarball = self.pack()
        result = self.scan(directory)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn(tarball.name, result.stdout)

    def test_empty_directory_fails(self):
        empty = self.root / "empty"
        empty.mkdir()
        result = self.scan(empty)
        self.assertEqual(result.returncode, 2)
        self.assertIn("No npm tarballs found", result.stderr)

    def test_workflow_scans_tarballs_copied_from_its_own_revision(self):
        workflow = (ROOT / ".github/workflows/npm-publish.yml").read_text()
        checkout_guard = workflow.index("      - name: Checkout publish guard\n")
        copy = workflow.index("      - name: Keep the tarball secret scan from the workflow revision\n")
        verify = workflow.index("      - name: Verify publish ref\n")
        checkout_release = workflow.index("      - name: Checkout\n")
        self.assertLess(checkout_guard, copy)
        self.assertLess(copy, verify)
        self.assertLess(verify, checkout_release)
        self.assertIn('cp scripts/releases/scan-npm-tarballs.sh .gitleaks.toml "$RUNNER_TEMP/publish-guard/"',
                      workflow[copy:verify])

        setup_node = workflow.index("      - name: Setup Node\n")
        setup_go = workflow.index("      - name: Setup Go\n")
        install = workflow.index("      - name: Install\n")
        self.assertLess(setup_node, setup_go)
        self.assertLess(setup_go, install)
        self.assertIn("actions/setup-go@40f1582b2485089dde7abd97c1529aa768e1baff", workflow[setup_go:install])
        self.assertIn("go-version-file: apps/api/go.mod", workflow[setup_go:install])
        self.assertIn("cache-dependency-path: apps/api/go.sum", workflow[setup_go:install])

        pack = workflow.index("      - name: Pack packages\n")
        scan = workflow.index("      - name: Scan packed packages for secrets\n")
        publish = workflow.index("      - name: Publish packages\n")
        self.assertLess(pack, scan)
        self.assertLess(scan, publish)
        self.assertNotIn("        if:", workflow[pack:scan])
        self.assertIn(
            'bash "$RUNNER_TEMP/publish-guard/scan-npm-tarballs.sh" '
            '"$RUNNER_TEMP/npm-packages" "$RUNNER_TEMP/publish-guard/.gitleaks.toml"',
            workflow[scan:publish],
        )


if __name__ == "__main__":
    unittest.main()
