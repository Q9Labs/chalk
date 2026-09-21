package recorderworker

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

const (
	uiBuildRegistrySchemaVersion = "recording_ui_build_registry.v1"
	maximumUIBuildRegistryBytes  = 16 << 10
	maximumUIBuildRegistryBuilds = 32
)

var ErrInvalidUIBuildRegistry = errors.New("invalid recording UI build registry")

// UIBuildRegistry is the bounded list of static UI trees installed in the
// immutable recorder image. Node independently recomputes the selected tree.
type UIBuildRegistry struct {
	builds map[string]struct{}
}

func LoadUIBuildRegistry(path string) (UIBuildRegistry, error) {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return UIBuildRegistry{}, ErrInvalidUIBuildRegistry
	}
	info, err := os.Lstat(path)
	if err != nil {
		return UIBuildRegistry{}, fmt.Errorf("inspect recording UI build registry: %w", err)
	}
	if !info.Mode().IsRegular() || info.Mode()&0o022 != 0 || info.Size() <= 0 || info.Size() > maximumUIBuildRegistryBytes {
		return UIBuildRegistry{}, ErrInvalidUIBuildRegistry
	}
	file, err := os.Open(path)
	if err != nil {
		return UIBuildRegistry{}, fmt.Errorf("open recording UI build registry: %w", err)
	}
	defer file.Close()
	registry, err := decodeUIBuildRegistry(file)
	if err != nil {
		return UIBuildRegistry{}, err
	}
	return registry, nil
}

func (registry UIBuildRegistry) Supports(sha256 string) bool {
	_, ok := registry.builds[sha256]
	return ok
}

func (registry UIBuildRegistry) valid() bool {
	if len(registry.builds) == 0 || len(registry.builds) > maximumUIBuildRegistryBuilds {
		return false
	}
	for sha256 := range registry.builds {
		if !isLowerSHA256(sha256) {
			return false
		}
	}
	return true
}

type uiBuildRegistryDocument struct {
	SchemaVersion string                 `json:"schema_version"`
	Builds        []uiBuildRegistryEntry `json:"builds"`
}

type uiBuildRegistryEntry struct {
	SHA256    string `json:"sha256"`
	Directory string `json:"directory"`
}

func decodeUIBuildRegistry(reader io.Reader) (UIBuildRegistry, error) {
	decoder := json.NewDecoder(reader)
	decoder.DisallowUnknownFields()
	var document uiBuildRegistryDocument
	if err := decoder.Decode(&document); err != nil {
		return UIBuildRegistry{}, fmt.Errorf("decode recording UI build registry: %w", err)
	}
	var trailing json.RawMessage
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return UIBuildRegistry{}, ErrInvalidUIBuildRegistry
	}
	if document.SchemaVersion != uiBuildRegistrySchemaVersion || len(document.Builds) == 0 || len(document.Builds) > maximumUIBuildRegistryBuilds {
		return UIBuildRegistry{}, ErrInvalidUIBuildRegistry
	}
	builds := make(map[string]struct{}, len(document.Builds))
	hasCurrent := false
	for _, entry := range document.Builds {
		if !isLowerSHA256(entry.SHA256) || !expectedUIBuildDirectory(entry.Directory, entry.SHA256) {
			return UIBuildRegistry{}, ErrInvalidUIBuildRegistry
		}
		if _, exists := builds[entry.SHA256]; exists {
			return UIBuildRegistry{}, ErrInvalidUIBuildRegistry
		}
		builds[entry.SHA256] = struct{}{}
		hasCurrent = hasCurrent || entry.Directory == "client"
	}
	registry := UIBuildRegistry{builds: builds}
	if !hasCurrent || !registry.valid() {
		return UIBuildRegistry{}, ErrInvalidUIBuildRegistry
	}
	return registry, nil
}

func expectedUIBuildDirectory(directory, sha256 string) bool {
	return directory == "client" || directory == filepath.ToSlash(filepath.Join("retained-clients", sha256))
}
