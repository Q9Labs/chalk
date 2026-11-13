package recordernodebootstrap

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
)

const hex64 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

func validManifest() imageManifest {
	return imageManifest{
		SchemaVersion: imageManifestSchemaVersion, ReleaseID: "r1", SourceCommit: "abc", SourceTreeSHA256: hex64,
		Profile: "cpu-libx264-frame2", BootstrapServerName: "boot.example.com", BootstrapCASHA256: hex64,
		Files: []imageManifestFile{{Path: "/a", Type: "file", SHA256: hex64}, {Path: "/b", Type: "file", SHA256: hex64}},
	}
}

func writeManifest(t *testing.T, data []byte) (path, digest string) {
	path = filepath.Join(t.TempDir(), "manifest.json")
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(data)
	return path, "sha256:" + hex.EncodeToString(sum[:])
}

func TestReadImageManifest(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(*imageManifest)
		role   workeridentity.Role
		want   string
	}{
		{"valid", func(*imageManifest) {}, workeridentity.RoleRender, ""},
		{"valid v2 portable", func(m *imageManifest) {
			m.SchemaVersion = "chalk_recorder_cpu_image.v2"
			m.BootstrapServerName, m.BootstrapCASHA256 = "", ""
		}, workeridentity.RoleRender, ""},
		{"v2 with server name", func(m *imageManifest) {
			m.SchemaVersion = "chalk_recorder_cpu_image.v2"
			m.BootstrapCASHA256 = ""
		}, workeridentity.RoleRender, "portable image contains environment claims"},
		{"v2 with ca", func(m *imageManifest) {
			m.SchemaVersion = "chalk_recorder_cpu_image.v2"
			m.BootstrapServerName = ""
		}, workeridentity.RoleRender, "portable image contains environment claims"},
		{"schema version", func(m *imageManifest) { m.SchemaVersion = "x" }, workeridentity.RoleRender, "invalid image manifest"},
		{"release", func(m *imageManifest) { m.ReleaseID = "other" }, workeridentity.RoleRender, "invalid image manifest"},
		{"empty source commit", func(m *imageManifest) { m.SourceCommit = "" }, workeridentity.RoleRender, "invalid image manifest"},
		{"source commit with equals", func(m *imageManifest) { m.SourceCommit = "a=b" }, workeridentity.RoleRender, "invalid image manifest"},
		{"tree sha uppercase", func(m *imageManifest) { m.SourceTreeSHA256 = strings.ToUpper(hex64) }, workeridentity.RoleRender, "invalid image manifest"},
		{"tree sha short", func(m *imageManifest) { m.SourceTreeSHA256 = "ab" }, workeridentity.RoleRender, "invalid image manifest"},
		{"profile", func(m *imageManifest) { m.Profile = "gpu" }, workeridentity.RoleRender, "invalid image manifest"},
		{"frame8 profile", func(m *imageManifest) { m.Profile = "cpu-libx264-frame8" }, workeridentity.RoleRender, ""},
		{"capture profile for render", func(m *imageManifest) { m.Profile = "capture-minimal-v1" }, workeridentity.RoleRender, "invalid image manifest"},
		{"capture profile for capture", func(m *imageManifest) { m.Profile = "capture-minimal-v1" }, workeridentity.RoleCapture, ""},
		{"no files", func(m *imageManifest) { m.Files = nil }, workeridentity.RoleRender, "invalid image manifest"},
		{"unsorted files", func(m *imageManifest) { m.Files[0], m.Files[1] = m.Files[1], m.Files[0] }, workeridentity.RoleRender, "invalid image manifest"},
		{"v1 server name", func(m *imageManifest) { m.BootstrapServerName = "a/b" }, workeridentity.RoleRender, "invalid image bootstrap claims"},
		{"v1 empty server name", func(m *imageManifest) { m.BootstrapServerName = "" }, workeridentity.RoleRender, "invalid image bootstrap claims"},
		{"v1 ca sha", func(m *imageManifest) { m.BootstrapCASHA256 = "zz" }, workeridentity.RoleRender, "invalid image bootstrap claims"},
		{"duplicate path", func(m *imageManifest) { m.Files[1].Path = "/a" }, workeridentity.RoleRender, "invalid image manifest file"},
		{"relative path", func(m *imageManifest) { m.Files = []imageManifestFile{{Path: "a", Type: "file", SHA256: hex64}} }, workeridentity.RoleRender, "invalid image manifest file"},
		{"unclean path", func(m *imageManifest) { m.Files = []imageManifestFile{{Path: "/a/", Type: "file", SHA256: hex64}} }, workeridentity.RoleRender, "invalid image manifest file"},
		{"file sha", func(m *imageManifest) { m.Files[1].SHA256 = "x" }, workeridentity.RoleRender, "invalid image manifest file"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			manifest := validManifest()
			tc.mutate(&manifest)
			data, err := json.Marshal(manifest)
			if err != nil {
				t.Fatal(err)
			}
			path, digest := writeManifest(t, data)
			got, err := readImageManifest(path, "r1", digest, tc.role)
			assertManifestError(t, err, tc.want)
			if err == nil && (got.ReleaseID != "r1" || len(got.Files) != 2) {
				t.Fatalf("unexpected manifest %+v", got)
			}
		})
	}
}

func assertManifestError(t *testing.T, err error, want string) {
	t.Helper()
	if want == "" {
		if err != nil {
			t.Fatalf("unexpected error %v", err)
		}
		return
	}
	if err == nil || err.Error() != ErrInvalidConfig.Error()+": "+want {
		t.Fatalf("error = %v, want %q", err, want)
	}
}

func TestReadImageManifestFileFailures(t *testing.T) {
	path, digest := writeManifest(t, []byte("{}"))
	cases := []struct {
		name string
		path string
		data []byte
		sum  string
		want string
	}{
		{"missing", filepath.Join(t.TempDir(), "none"), nil, "", "read image manifest"},
		{"empty", "", []byte{}, "", "read image manifest"},
		{"oversize", "", []byte(strings.Repeat(" ", 32<<20+1)), "", "read image manifest"},
		{"digest", path, nil, "sha256:" + hex64, "image manifest digest mismatch"},
		{"not json", "", []byte("{"), "", "invalid image manifest"},
		{"unknown field", "", []byte(`{"extra":1}`), "", "invalid image manifest"},
		{"empty object", path, nil, digest, "invalid image manifest"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			path, sum := tc.path, tc.sum
			if tc.data != nil {
				var computed string
				path, computed = writeManifest(t, tc.data)
				if sum == "" {
					sum = computed
				}
			}
			_, err := readImageManifest(path, "r1", sum, workeridentity.RoleRender)
			assertManifestError(t, err, tc.want)
		})
	}
}
