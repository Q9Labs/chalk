import importlib.util
from pathlib import Path
import tempfile
import unittest


SOURCE = Path(__file__).resolve().parents[2] / 'apps/api/internal/adapters/digitalocean/recorder_install.py'
spec = importlib.util.spec_from_file_location('recorder_install', SOURCE)
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class InstalledReleaseContract(unittest.TestCase):
    def test_verified_archive_replaces_receiptless_baked_release(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / 'selected'
            target.mkdir()
            (target / 'binary').write_bytes(b'baked bytes')
            stage = root / '.stage'
            stage.mkdir()
            release = stage / 'release'
            release.mkdir()
            (release / 'binary').write_bytes(b'verified archive bytes')
            (release / '.archive-sha256').write_text('a' * 64)
            installer.select_release(release, target, 'a' * 64)
            self.assertEqual((target / 'binary').read_bytes(), b'verified archive bytes')
            self.assertEqual((stage / 'previous/binary').read_bytes(), b'baked bytes')
            installer.select_release(release, target, 'a' * 64)
            with self.assertRaisesRegex(ValueError, 'different bytes'):
                installer.select_release(release, target, 'b' * 64)

    def test_failed_selection_restores_baked_release(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / 'selected'
            target.mkdir()
            (target / 'binary').write_bytes(b'baked bytes')
            with self.assertRaises(FileNotFoundError):
                installer.select_release(root / 'missing', target, 'a' * 64)
            self.assertEqual((target / 'binary').read_bytes(), b'baked bytes')

    def test_download_checksum_and_extraction_failures_have_bounded_reasons(self):
        import hashlib
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bundle = root / 'invalid.tar.gz'
            bundle.write_bytes(b'not an archive')
            config = dict(release_id='test', sha256='a' * 64, manifest_digest='sha256:'+'a'*64)
            for url, sha, reason in (
                ((root / 'absent').as_uri(), 'a'*64, 'archive_download_failed'),
                (bundle.as_uri(), 'a'*64, 'archive_verification_failed'),
                (bundle.as_uri(), hashlib.sha256(bundle.read_bytes()).hexdigest(), 'archive_extraction_failed'),
            ):
                with self.subTest(reason=reason):
                    config.update(url=url, sha256=sha)
                    with self.assertRaisesRegex(installer.ArchiveInstallError, '^'+reason+'$'):
                        installer.install(config, root)
                    self.assertFalse((root / 'releases/test').exists())
