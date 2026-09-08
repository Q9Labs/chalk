package recordernodebootstrap

import (
	"bufio"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/q9labs/chalk/apps/api/internal/recorderfleet"
	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
)

var ErrInvalidConfig = errors.New("invalid recorder node bootstrap config")

type Config struct {
	Environment         string
	Role                workeridentity.Role
	ReleaseID           string
	ImageDigest         string
	BootGeneration      uint64
	BootstrapEndpoint   string
	BootstrapCAFile     string
	BootstrapServerName string
	IdentityDirectory   string
	WorkerEnvironment   string
	NodeEnvironment     string
	ImageManifest       string
}

func LoadConfig(bootstrapEnvironmentFile, imageEnvironmentFile string) (Config, error) {
	return loadConfig(bootstrapEnvironmentFile, imageEnvironmentFile, true)
}

func LoadRenewalConfig(nodeEnvironmentFile, imageEnvironmentFile string) (Config, error) {
	return loadConfig(nodeEnvironmentFile, imageEnvironmentFile, false)
}

func loadConfig(bootstrapEnvironmentFile, imageEnvironmentFile string, verifyAttestation bool) (Config, error) {
	bootstrap, err := readEnvironmentFile(bootstrapEnvironmentFile, map[string]struct{}{
		"CHALK_RECORDER_ENVIRONMENT": {}, "CHALK_RECORDER_POOL": {}, "CHALK_RECORDER_RELEASE": {},
		"CHALK_RECORDER_IMAGE_DIGEST": {}, "CHALK_RECORDER_BOOTSTRAP_ENDPOINT": {},
		"CHALK_RECORDER_BOOT_GENERATION": {}, "CHALK_RECORDER_GPU": {},
		"CHALK_RECORDER_BOOTSTRAP_ASSERTION_SOURCE": {},
	})
	if err != nil {
		return Config{}, err
	}
	image, err := readEnvironmentFile(imageEnvironmentFile, map[string]struct{}{
		"CHALK_RECORDER_IMAGE_GPU":            {},
		"CHALK_RECORDER_INSTALLED_RELEASE_ID": {}, "CHALK_RECORDER_INSTALLED_IMAGE_DIGEST": {},
		"CHALK_RECORDER_IMAGE_MANIFEST":    {},
		"CHALK_RECORDER_BOOTSTRAP_CA_FILE": {}, "CHALK_RECORDER_BOOTSTRAP_SERVER_NAME": {},
		"CHALK_RECORDER_IDENTITY_DIRECTORY": {}, "CHALK_RECORDER_WORKER_ENV_FILE": {},
		"CHALK_RECORDER_NODE_ENV_FILE": {},
	})
	if err != nil {
		return Config{}, err
	}

	bootGeneration, err := strconv.ParseUint(bootstrap["CHALK_RECORDER_BOOT_GENERATION"], 10, 64)
	if err != nil || bootGeneration == 0 {
		return Config{}, fmt.Errorf("%w: boot generation", ErrInvalidConfig)
	}
	role := workeridentity.Role(bootstrap["CHALK_RECORDER_POOL"])
	gpu, gpuErr := strconv.ParseBool(bootstrap["CHALK_RECORDER_GPU"])
	imageGPU, imageGPUErr := strconv.ParseBool(image["CHALK_RECORDER_IMAGE_GPU"])
	if gpuErr != nil || imageGPUErr != nil || gpu != imageGPU {
		return Config{}, fmt.Errorf("%w: image accelerator mismatch", ErrInvalidConfig)
	}
	if bootstrap["CHALK_RECORDER_RELEASE"] != image["CHALK_RECORDER_INSTALLED_RELEASE_ID"] || bootstrap["CHALK_RECORDER_IMAGE_DIGEST"] != image["CHALK_RECORDER_INSTALLED_IMAGE_DIGEST"] {
		return Config{}, fmt.Errorf("%w: installed image attestation mismatch", ErrInvalidConfig)
	}
	if role != workeridentity.RoleCapture && role != workeridentity.RoleRender || gpu {
		return Config{}, fmt.Errorf("%w: this image requires a CPU recorder release", ErrInvalidConfig)
	}
	config := Config{
		Environment: bootstrap["CHALK_RECORDER_ENVIRONMENT"], Role: role,
		ReleaseID: bootstrap["CHALK_RECORDER_RELEASE"], ImageDigest: bootstrap["CHALK_RECORDER_IMAGE_DIGEST"],
		BootGeneration: bootGeneration, BootstrapEndpoint: bootstrap["CHALK_RECORDER_BOOTSTRAP_ENDPOINT"],
		BootstrapCAFile: image["CHALK_RECORDER_BOOTSTRAP_CA_FILE"], BootstrapServerName: image["CHALK_RECORDER_BOOTSTRAP_SERVER_NAME"],
		IdentityDirectory: image["CHALK_RECORDER_IDENTITY_DIRECTORY"], WorkerEnvironment: image["CHALK_RECORDER_WORKER_ENV_FILE"],
		NodeEnvironment: image["CHALK_RECORDER_NODE_ENV_FILE"],
		ImageManifest:   image["CHALK_RECORDER_IMAGE_MANIFEST"],
	}
	if err := config.Validate(); err != nil {
		return Config{}, err
	}
	if bootstrap["CHALK_RECORDER_BOOTSTRAP_ASSERTION_SOURCE"] != "external-reconciler" {
		return Config{}, fmt.Errorf("%w: bootstrap authority", ErrInvalidConfig)
	}
	if verifyAttestation {
		if err := VerifyImageManifest(config.ImageManifest, config.ReleaseID, config.ImageDigest); err != nil {
			return Config{}, err
		}
	}
	return config, nil
}

func (config Config) Validate() error {
	key := recorderfleet.PoolKey{Environment: config.Environment, Role: config.Role}
	endpoint, err := url.Parse(config.BootstrapEndpoint)
	if err != nil || endpoint.Scheme != "https" || endpoint.Host == "" || endpoint.User != nil || endpoint.RawQuery != "" || endpoint.Fragment != "" || endpoint.Path != "" && endpoint.Path != "/" {
		return fmt.Errorf("%w: bootstrap endpoint", ErrInvalidConfig)
	}
	if key.Validate() != nil || !validClaim(config.ReleaseID, 128) || !validSHA256(config.ImageDigest) || config.BootGeneration == 0 {
		return ErrInvalidConfig
	}
	if !validServerName(config.BootstrapServerName) {
		return fmt.Errorf("%w: bootstrap server name", ErrInvalidConfig)
	}
	for label, path := range map[string]string{
		"bootstrap ca": config.BootstrapCAFile, "identity directory": config.IdentityDirectory, "worker environment": config.WorkerEnvironment,
		"node environment": config.NodeEnvironment, "image manifest": config.ImageManifest,
	} {
		if !filepath.IsAbs(path) || filepath.Clean(path) != path {
			return fmt.Errorf("%w: %s path", ErrInvalidConfig, label)
		}
	}
	return nil
}

func readEnvironmentFile(path string, allowed map[string]struct{}) (map[string]string, error) {
	if !filepath.IsAbs(path) {
		return nil, fmt.Errorf("%w: environment file path", ErrInvalidConfig)
	}
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o022 != 0 || info.Size() > 16<<10 {
		return nil, fmt.Errorf("%w: unsafe environment file", ErrInvalidConfig)
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("%w: open environment file", ErrInvalidConfig)
	}
	defer file.Close()

	values := make(map[string]string, len(allowed))
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		name, value, ok := strings.Cut(line, "=")
		if !ok {
			return nil, fmt.Errorf("%w: malformed environment line", ErrInvalidConfig)
		}
		if _, ok := allowed[name]; !ok {
			return nil, fmt.Errorf("%w: unsupported environment key %s", ErrInvalidConfig, name)
		}
		if _, duplicate := values[name]; duplicate {
			return nil, fmt.Errorf("%w: duplicate environment key %s", ErrInvalidConfig, name)
		}
		decoded, err := decodeEnvironmentValue(value)
		if err != nil {
			return nil, err
		}
		values[name] = decoded
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("%w: read environment file", ErrInvalidConfig)
	}
	for name := range allowed {
		if values[name] == "" {
			return nil, fmt.Errorf("%w: missing environment key %s", ErrInvalidConfig, name)
		}
	}
	return values, nil
}

func decodeEnvironmentValue(value string) (string, error) {
	if len(value) >= 2 && value[0] == '\'' && value[len(value)-1] == '\'' {
		value = value[1 : len(value)-1]
		if strings.Contains(value, "'") {
			return "", fmt.Errorf("%w: unsupported quoted environment value", ErrInvalidConfig)
		}
	}
	if value == "" || strings.TrimSpace(value) != value || strings.ContainsAny(value, "\r\n\x00") {
		return "", fmt.Errorf("%w: environment value", ErrInvalidConfig)
	}
	return value, nil
}

func validClaim(value string, maximum int) bool {
	return value != "" && len(value) <= maximum && strings.TrimSpace(value) == value && !strings.ContainsAny(value, "\r\n\x00=")
}

func validSHA256(value string) bool {
	if !strings.HasPrefix(value, "sha256:") || len(value) != len("sha256:")+64 || strings.ToLower(value) != value {
		return false
	}
	for _, character := range strings.TrimPrefix(value, "sha256:") {
		if character < '0' || character > '9' && character < 'a' || character > 'f' {
			return false
		}
	}
	return true
}

func validServerName(value string) bool {
	return validClaim(value, 253) && !strings.ContainsAny(value, "/\\:")
}
