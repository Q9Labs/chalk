package recordernodebootstrap

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
)

const imageManifestSchemaVersion = "chalk_recorder_cpu_image.v1"

type imageManifest struct {
	SchemaVersion       string              `json:"schema_version"`
	ReleaseID           string              `json:"release_id"`
	SourceCommit        string              `json:"source_commit"`
	SourceTreeSHA256    string              `json:"source_tree_sha256"`
	Profile             string              `json:"profile"`
	BootstrapServerName string              `json:"bootstrap_server_name"`
	BootstrapCASHA256   string              `json:"bootstrap_ca_sha256"`
	Files               []imageManifestFile `json:"files"`
}

type ImageBootstrapClaims struct {
	ServerName string
	CASHA256   string
}

type imageManifestFile struct {
	Path   string `json:"path"`
	Type   string `json:"type"`
	SHA256 string `json:"sha256"`
}

func VerifyImageManifest(path, releaseID, expectedDigest string, role workeridentity.Role) error {
	manifest, err := readImageManifest(path, releaseID, expectedDigest, role)
	if err != nil {
		return err
	}
	for _, file := range manifest.Files {
		computed, err := installedPathSHA256(file.Path, file.Type)
		if err != nil || computed != file.SHA256 {
			return fmt.Errorf("%w: image file digest mismatch for %s", ErrInvalidConfig, file.Path)
		}
	}
	return nil
}

// VerifyImageManifestClaims checks the attested claims without needing the image's installed files.
func VerifyImageManifestClaims(path, releaseID, expectedDigest string, role workeridentity.Role) (ImageBootstrapClaims, error) {
	manifest, err := readImageManifest(path, releaseID, expectedDigest, role)
	if err != nil {
		return ImageBootstrapClaims{}, err
	}
	return ImageBootstrapClaims{ServerName: manifest.BootstrapServerName, CASHA256: manifest.BootstrapCASHA256}, nil
}

func readImageManifest(path, releaseID, expectedDigest string, role workeridentity.Role) (imageManifest, error) {
	data, err := os.ReadFile(path)
	if err != nil || len(data) == 0 || len(data) > 32<<20 {
		return imageManifest{}, fmt.Errorf("%w: read image manifest", ErrInvalidConfig)
	}
	digest := sha256.Sum256(data)
	if "sha256:"+hex.EncodeToString(digest[:]) != expectedDigest {
		return imageManifest{}, fmt.Errorf("%w: image manifest digest mismatch", ErrInvalidConfig)
	}
	var manifest imageManifest
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&manifest) != nil || manifest.SchemaVersion != imageManifestSchemaVersion || manifest.ReleaseID != releaseID || !validClaim(manifest.SourceCommit, 128) || !validHexSHA256(manifest.SourceTreeSHA256) || !validImageProfile(manifest.Profile, role) || !validServerName(manifest.BootstrapServerName) || !validHexSHA256(manifest.BootstrapCASHA256) || len(manifest.Files) == 0 || !slices.IsSortedFunc(manifest.Files, func(left, right imageManifestFile) int { return strings.Compare(left.Path, right.Path) }) {
		return imageManifest{}, fmt.Errorf("%w: invalid image manifest", ErrInvalidConfig)
	}
	previous := ""
	for _, file := range manifest.Files {
		if file.Path == previous || !filepath.IsAbs(file.Path) || filepath.Clean(file.Path) != file.Path || !validHexSHA256(file.SHA256) {
			return imageManifest{}, fmt.Errorf("%w: invalid image manifest file", ErrInvalidConfig)
		}
		previous = file.Path
	}
	return manifest, nil
}

func validImageProfile(profile string, role workeridentity.Role) bool {
	return profile == "cpu-libx264-frame2" || profile == "cpu-libx264-frame8" || profile == "capture-minimal-v1" && role == workeridentity.RoleCapture
}

func installedPathSHA256(path, pathType string) (string, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return "", ErrInvalidConfig
	}
	if pathType == "symlink" {
		if info.Mode()&os.ModeSymlink == 0 {
			return "", ErrInvalidConfig
		}
		target, err := os.Readlink(path)
		if err != nil || target == "" {
			return "", ErrInvalidConfig
		}
		resolved := target
		if !filepath.IsAbs(resolved) {
			resolved = filepath.Join(filepath.Dir(path), resolved)
		}
		resolved = filepath.Clean(resolved)
		if resolved != "/opt/chalk-recorder" && !strings.HasPrefix(resolved, "/opt/chalk-recorder/") {
			return "", ErrInvalidConfig
		}
		digest := sha256.Sum256([]byte(target))
		return hex.EncodeToString(digest[:]), nil
	}
	if pathType != "file" || !info.Mode().IsRegular() {
		return "", ErrInvalidConfig
	}
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func validHexSHA256(value string) bool {
	if len(value) != sha256.Size*2 || strings.ToLower(value) != value {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil
}
