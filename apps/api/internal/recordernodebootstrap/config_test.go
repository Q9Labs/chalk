package recordernodebootstrap

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
)

type configFixture struct {
	dir       string
	bootstrap map[string]string
	image     map[string]string
}

func newConfigFixture(t *testing.T) *configFixture {
	t.Helper()
	dir := t.TempDir()
	installed := filepath.Join(dir, "installed")
	if err := os.WriteFile(installed, []byte("payload"), 0o600); err != nil {
		t.Fatal(err)
	}
	payloadSum := sha256.Sum256([]byte("payload"))
	ca := []byte("ca-bytes")
	if err := os.WriteFile(filepath.Join(dir, "ca.pem"), ca, 0o600); err != nil {
		t.Fatal(err)
	}
	caSum := sha256.Sum256(ca)
	manifest := imageManifest{
		SchemaVersion: imageManifestSchemaVersion, ReleaseID: "r1", SourceCommit: "abc", SourceTreeSHA256: hex64,
		Profile: "cpu-libx264-frame2", BootstrapServerName: "boot.example.com", BootstrapCASHA256: hex.EncodeToString(caSum[:]),
		Files: []imageManifestFile{{Path: installed, Type: "file", SHA256: hex.EncodeToString(payloadSum[:])}},
	}
	data, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	manifestPath := filepath.Join(dir, "manifest.json")
	if err := os.WriteFile(manifestPath, data, 0o600); err != nil {
		t.Fatal(err)
	}
	manifestSum := sha256.Sum256(data)
	digest := "sha256:" + hex.EncodeToString(manifestSum[:])
	return &configFixture{
		dir: dir,
		bootstrap: map[string]string{
			"CHALK_RECORDER_ENVIRONMENT": "staging", "CHALK_RECORDER_POOL": "capture", "CHALK_RECORDER_RELEASE": "r1",
			"CHALK_RECORDER_IMAGE_DIGEST": digest, "CHALK_RECORDER_BOOTSTRAP_ENDPOINT": "https://boot.example.com",
			"CHALK_RECORDER_BOOT_GENERATION": "3", "CHALK_RECORDER_GPU": "false",
			"CHALK_RECORDER_BOOTSTRAP_ASSERTION_SOURCE": "external-reconciler",
		},
		image: map[string]string{
			"CHALK_RECORDER_IMAGE_GPU": "false", "CHALK_RECORDER_INSTALLED_RELEASE_ID": "r1", "CHALK_RECORDER_INSTALLED_IMAGE_DIGEST": digest,
			"CHALK_RECORDER_IMAGE_MANIFEST": manifestPath, "CHALK_RECORDER_BOOTSTRAP_CA_FILE": filepath.Join(dir, "ca.pem"),
			"CHALK_RECORDER_BOOTSTRAP_SERVER_NAME": "boot.example.com", "CHALK_RECORDER_IDENTITY_DIRECTORY": "/var/lib/identity",
			"CHALK_RECORDER_WORKER_ENV_FILE": "/etc/worker.env", "CHALK_RECORDER_NODE_ENV_FILE": "/etc/node.env",
		},
	}
}

func writeEnv(t *testing.T, path string, values map[string]string) {
	t.Helper()
	var builder strings.Builder
	for name, value := range values {
		builder.WriteString(name + "=" + value + "\n")
	}
	if err := os.WriteFile(path, []byte(builder.String()), 0o600); err != nil {
		t.Fatal(err)
	}
}

func (f *configFixture) paths(t *testing.T) (bootstrap, image string) {
	bootstrap, image = filepath.Join(f.dir, "bootstrap.env"), filepath.Join(f.dir, "image.env")
	writeEnv(t, bootstrap, f.bootstrap)
	writeEnv(t, image, f.image)
	return bootstrap, image
}

func TestLoadConfig(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(f *configFixture)
		verify bool
		want   string
	}{
		{"valid", func(*configFixture) {}, true, ""},
		{"valid renewal", func(f *configFixture) { f.image["CHALK_RECORDER_IMAGE_MANIFEST"] = "/nonexistent/manifest.json" }, false, ""},
		{"zero boot generation", func(f *configFixture) { f.bootstrap["CHALK_RECORDER_BOOT_GENERATION"] = "0" }, true, "boot generation"},
		{"bad boot generation", func(f *configFixture) { f.bootstrap["CHALK_RECORDER_BOOT_GENERATION"] = "x" }, true, "boot generation"},
		{"bad gpu", func(f *configFixture) { f.bootstrap["CHALK_RECORDER_GPU"] = "maybe" }, true, "image accelerator mismatch"},
		{"bad image gpu", func(f *configFixture) { f.image["CHALK_RECORDER_IMAGE_GPU"] = "maybe" }, true, "image accelerator mismatch"},
		{"gpu mismatch", func(f *configFixture) { f.image["CHALK_RECORDER_IMAGE_GPU"] = "true" }, true, "image accelerator mismatch"},
		{"release mismatch", func(f *configFixture) { f.image["CHALK_RECORDER_INSTALLED_RELEASE_ID"] = "r2" }, true, "installed image attestation mismatch"},
		{"digest mismatch", func(f *configFixture) { f.image["CHALK_RECORDER_INSTALLED_IMAGE_DIGEST"] = "sha256:" + hex64 }, true, "installed image attestation mismatch"},
		{"gpu image", func(f *configFixture) {
			f.bootstrap["CHALK_RECORDER_GPU"], f.image["CHALK_RECORDER_IMAGE_GPU"] = "true", "true"
		}, true, "this image requires a CPU recorder release"},
		{"unknown role", func(f *configFixture) { f.bootstrap["CHALK_RECORDER_POOL"] = "other" }, true, "this image requires a CPU recorder release"},
		{"render role", func(f *configFixture) { f.bootstrap["CHALK_RECORDER_POOL"] = "render" }, false, ""},
		{"invalid config", func(f *configFixture) { f.bootstrap["CHALK_RECORDER_BOOTSTRAP_ENDPOINT"] = "http://boot.example.com" }, true, "bootstrap endpoint"},
		{"assertion source", func(f *configFixture) { f.bootstrap["CHALK_RECORDER_BOOTSTRAP_ASSERTION_SOURCE"] = "node" }, true, "bootstrap authority"},
		{"manifest missing", func(f *configFixture) { f.image["CHALK_RECORDER_IMAGE_MANIFEST"] = "/nonexistent/manifest.json" }, true, "read image manifest"},
		{"ca missing", func(f *configFixture) { f.image["CHALK_RECORDER_BOOTSTRAP_CA_FILE"] = "/nonexistent/ca.pem" }, true, "read bootstrap CA"},
		{"ca differs", func(f *configFixture) {
			if err := os.WriteFile(f.image["CHALK_RECORDER_BOOTSTRAP_CA_FILE"], []byte("other"), 0o600); err != nil {
				panic(err)
			}
		}, true, "installed bootstrap TLS settings differ from image manifest"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			fixture := newConfigFixture(t)
			tc.mutate(fixture)
			bootstrap, image := fixture.paths(t)
			load := LoadRenewalConfig
			if tc.verify {
				load = LoadConfig
			}
			config, err := load(bootstrap, image)
			assertManifestError(t, err, tc.want)
			if err == nil && (config.Environment != "staging" || config.ReleaseID != "r1" || config.BootGeneration != 3 || config.BootstrapServerName != "boot.example.com" || config.NodeEnvironment != "/etc/node.env" || config.IdentityDirectory != "/var/lib/identity") {
				t.Fatalf("unexpected config %+v", config)
			}
		})
	}

	fixture := newConfigFixture(t)
	bootstrap, image := fixture.paths(t)
	if _, err := LoadConfig("relative.env", image); !errors.Is(err, ErrInvalidConfig) {
		t.Fatalf("error = %v", err)
	}
	if _, err := LoadConfig(bootstrap, "relative.env"); !errors.Is(err, ErrInvalidConfig) {
		t.Fatalf("error = %v", err)
	}
}

func validConfig() Config {
	return Config{
		Environment: "staging", Role: workeridentity.RoleCapture, ReleaseID: "r1", ImageDigest: "sha256:" + hex64, BootGeneration: 1,
		BootstrapEndpoint: "https://Boot.example.com/", BootstrapServerName: "boot.example.com", BootstrapCAFile: "/ca.pem",
		IdentityDirectory: "/identity", WorkerEnvironment: "/worker.env", NodeEnvironment: "/node.env", ImageManifest: "/manifest.json",
	}
}

func TestConfigValidate(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(*Config)
		want   string
	}{
		{"valid", func(*Config) {}, ""},
		{"endpoint without slash", func(c *Config) { c.BootstrapEndpoint = "https://boot.example.com" }, ""},
		{"bad endpoint", func(c *Config) { c.BootstrapEndpoint = "://" }, "bootstrap endpoint"},
		{"http endpoint", func(c *Config) { c.BootstrapEndpoint = "http://boot.example.com" }, "bootstrap endpoint"},
		{"no host", func(c *Config) { c.BootstrapEndpoint = "https:///x" }, "bootstrap endpoint"},
		{"userinfo", func(c *Config) { c.BootstrapEndpoint = "https://u@boot.example.com" }, "bootstrap endpoint"},
		{"query", func(c *Config) { c.BootstrapEndpoint = "https://boot.example.com?x=1" }, "bootstrap endpoint"},
		{"fragment", func(c *Config) { c.BootstrapEndpoint = "https://boot.example.com#x" }, "bootstrap endpoint"},
		{"path", func(c *Config) { c.BootstrapEndpoint = "https://boot.example.com/x" }, "bootstrap endpoint"},
		{"environment", func(c *Config) { c.Environment = "Bad" }, ""},
		{"role", func(c *Config) { c.Role = "other" }, ""},
		{"release", func(c *Config) { c.ReleaseID = "" }, ""},
		{"long release", func(c *Config) { c.ReleaseID = strings.Repeat("a", 129) }, ""},
		{"digest", func(c *Config) { c.ImageDigest = "sha256:abc" }, ""},
		{"boot generation", func(c *Config) { c.BootGeneration = 0 }, ""},
		{"server name", func(c *Config) { c.BootstrapServerName = "a/b" }, "bootstrap server name"},
		{"host differs", func(c *Config) { c.BootstrapServerName = "other.example.com" }, `bootstrap server name "other.example.com" differs from endpoint host "Boot.example.com"`},
		{"ca path", func(c *Config) { c.BootstrapCAFile = "ca.pem" }, "bootstrap ca path"},
		{"identity path", func(c *Config) { c.IdentityDirectory = "/a/../identity" }, "identity directory path"},
		{"worker path", func(c *Config) { c.WorkerEnvironment = "/a//worker.env" }, "worker environment path"},
		{"node path", func(c *Config) { c.NodeEnvironment = "" }, "node environment path"},
		{"manifest path", func(c *Config) { c.ImageManifest = "manifest.json" }, "image manifest path"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			config := validConfig()
			tc.mutate(&config)
			err := config.Validate()
			switch {
			case tc.want != "":
				assertManifestError(t, err, tc.want)
			case tc.name == "valid" || tc.name == "endpoint without slash":
				if err != nil {
					t.Fatalf("unexpected error %v", err)
				}
			default:
				if err == nil || err.Error() != ErrInvalidConfig.Error() {
					t.Fatalf("error = %v, want bare ErrInvalidConfig", err)
				}
			}
		})
	}
}

func TestReadEnvironmentFile(t *testing.T) {
	allowed := map[string]struct{}{"A": {}, "B": {}}
	write := func(t *testing.T, content string, mode os.FileMode) string {
		path := filepath.Join(t.TempDir(), "env")
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(path, mode); err != nil {
			t.Fatal(err)
		}
		return path
	}
	cases := []struct {
		name    string
		content string
		mode    os.FileMode
		want    string
		values  map[string]string
	}{
		{"valid", "# comment\n\nA=1\n  B='two words'  \n", 0o600, "", map[string]string{"A": "1", "B": "two words"}},
		{"readable by all", "A=1\nB=2\n", 0o644, "", map[string]string{"A": "1", "B": "2"}},
		{"group writable", "A=1\nB=2\n", 0o660, "unsafe environment file", nil},
		{"world writable", "A=1\nB=2\n", 0o602, "unsafe environment file", nil},
		{"oversize", "A=1\nB=2\n#" + strings.Repeat("x", 16<<10), 0o600, "unsafe environment file", nil},
		{"malformed", "A\nB=2\n", 0o600, "malformed environment line", nil},
		{"unsupported key", "A=1\nC=2\n", 0o600, "unsupported environment key C", nil},
		{"duplicate", "A=1\nA=2\n", 0o600, "duplicate environment key A", nil},
		{"inner quote", "A='a'b'\nB=2\n", 0o600, "unsupported quoted environment value", nil},
		{"empty value", "A=\nB=2\n", 0o600, "environment value", nil},
		{"empty quoted value", "A=''\nB=2\n", 0o600, "environment value", nil},
		{"padded quoted value", "A=' x'\nB=2\n", 0o600, "environment value", nil},
		{"nul value", "A=x\x00y\nB=2\n", 0o600, "environment value", nil},
		{"missing key", "A=1\n", 0o600, "missing environment key B", nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			values, err := readEnvironmentFile(write(t, tc.content, tc.mode), allowed)
			assertManifestError(t, err, tc.want)
			if tc.want == "" && (values["A"] != tc.values["A"] || values["B"] != tc.values["B"] || len(values) != 2) {
				t.Fatalf("values = %v", values)
			}
		})
	}

	if _, err := readEnvironmentFile("relative", allowed); err == nil || err.Error() != ErrInvalidConfig.Error()+": environment file path" {
		t.Fatalf("error = %v", err)
	}
	assertManifestError(t, func() error {
		_, err := readEnvironmentFile(filepath.Join(t.TempDir(), "none"), allowed)
		return err
	}(), "unsafe environment file")
	dir := t.TempDir()
	target := write(t, "A=1\nB=2\n", 0o600)
	link := filepath.Join(dir, "link")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	_, err := readEnvironmentFile(link, allowed)
	assertManifestError(t, err, "unsafe environment file")
	if os.Geteuid() != 0 {
		unreadable := write(t, "A=1\nB=2\n", 0)
		_, err := readEnvironmentFile(unreadable, allowed)
		assertManifestError(t, err, "open environment file")
	}
}
