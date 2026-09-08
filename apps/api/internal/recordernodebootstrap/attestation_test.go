package recordernodebootstrap

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestVerifyImageManifestDetectsInstalledFileTamper(t *testing.T) {
	directory := t.TempDir()
	installedPath := filepath.Join(directory, "recorder-render")
	if err := os.WriteFile(installedPath, []byte("release-binary"), 0o755); err != nil {
		t.Fatalf("write installed file: %v", err)
	}
	installedDigest := sha256.Sum256([]byte("release-binary"))
	manifest := imageManifest{
		SchemaVersion:    imageManifestSchemaVersion,
		ReleaseID:        "release-1",
		SourceCommit:     "1111111111111111111111111111111111111111",
		SourceTreeSHA256: "2222222222222222222222222222222222222222222222222222222222222222",
		Profile:          "cpu-libx264-frame8",
		Files:            []imageManifestFile{{Path: installedPath, Type: "file", SHA256: hex.EncodeToString(installedDigest[:])}},
	}
	manifestData, err := json.Marshal(manifest)
	if err != nil {
		t.Fatalf("marshal manifest: %v", err)
	}
	manifestPath := filepath.Join(directory, "image-manifest.json")
	if err := os.WriteFile(manifestPath, manifestData, 0o644); err != nil {
		t.Fatalf("write manifest: %v", err)
	}
	manifestDigest := sha256.Sum256(manifestData)
	expectedDigest := "sha256:" + hex.EncodeToString(manifestDigest[:])
	if err := VerifyImageManifest(manifestPath, manifest.ReleaseID, expectedDigest); err != nil {
		t.Fatalf("verify image manifest: %v", err)
	}

	if err := os.WriteFile(installedPath, []byte("tampered"), 0o755); err != nil {
		t.Fatalf("tamper installed file: %v", err)
	}
	if err := VerifyImageManifest(manifestPath, manifest.ReleaseID, expectedDigest); !errors.Is(err, ErrInvalidConfig) {
		t.Fatalf("tampered image error = %v, want invalid config", err)
	}
}

func TestInstalledPathSHA256RejectsSymlinkOutsideRecorderRoot(t *testing.T) {
	symlinkPath := filepath.Join(t.TempDir(), "current")
	target := "/opt/chalk-recorder/releases/release-1"
	if err := os.Symlink(target, symlinkPath); err != nil {
		t.Fatalf("create recorder symlink: %v", err)
	}
	targetDigest := sha256.Sum256([]byte(target))
	if got, err := installedPathSHA256(symlinkPath, "symlink"); err != nil || got != hex.EncodeToString(targetDigest[:]) {
		t.Fatalf("symlink digest/error = %q/%v", got, err)
	}
	if err := os.Remove(symlinkPath); err != nil {
		t.Fatalf("remove recorder symlink: %v", err)
	}
	if err := os.Symlink("/etc/passwd", symlinkPath); err != nil {
		t.Fatalf("retarget recorder symlink: %v", err)
	}
	if _, err := installedPathSHA256(symlinkPath, "symlink"); !errors.Is(err, ErrInvalidConfig) {
		t.Fatalf("outside-root symlink error = %v, want invalid config", err)
	}
}

func TestRenewalTimeUsesOneThirdLifetimeLead(t *testing.T) {
	now := time.Date(2026, 9, 8, 12, 0, 0, 0, time.UTC)
	for _, test := range []struct {
		name     string
		lifetime time.Duration
		want     time.Time
	}{
		{name: "qualification", lifetime: 3 * time.Minute, want: now.Add(2 * time.Minute)},
		{name: "production", lifetime: 12 * time.Hour, want: now.Add(8 * time.Hour)},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := renewalTime(now, now.Add(test.lifetime)); !got.Equal(test.want) {
				t.Fatalf("renewal time = %s, want %s", got, test.want)
			}
		})
	}
}
