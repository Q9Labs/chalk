package digitalocean

import (
	"crypto/x509"
	_ "embed"
	"encoding/base64"
	"encoding/json"
	"net/url"
	"strconv"
	"strings"

	"github.com/q9labs/chalk/apps/api/internal/recorderfleet"
	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
)

//go:embed recorder_install.py
var recorderInstaller []byte

func renderRecorderCloudInit(request recorderfleet.EnsureNodeRequest, archiveURL string, slotsPerNode int) (string, error) {
	if err := request.Validate(); err != nil {
		return "", err
	}
	if slotsPerNode < 1 || slotsPerNode > 100 {
		return "", recorderfleet.ErrInvalidConfig
	}
	parsed, err := url.Parse(archiveURL)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil {
		return "", recorderfleet.ErrInvalidConfig
	}
	archiveConfig, err := json.Marshal(struct {
		URL            string `json:"url"`
		SHA256         string `json:"sha256"`
		ReleaseID      string `json:"release_id"`
		ManifestDigest string `json:"manifest_digest"`
		Endpoint       string `json:"endpoint"`
		BootGeneration uint64 `json:"boot_generation"`
	}{archiveURL, request.Release.Archive.SHA256, request.Release.ReleaseID, request.Release.ImageDigest, request.Release.BootstrapEndpoint, request.BootGeneration})
	if err != nil {
		return "", err
	}
	installFiles := "  - path: /run/chalk-recorder-install.py\n    permissions: \"0500\"\n    owner: root:root\n    encoding: b64\n    content: " + base64.StdEncoding.EncodeToString(recorderInstaller) + "\n" +
		"  - path: /etc/chalk-recorder/archive.json\n    permissions: \"0400\"\n    owner: root:root\n    encoding: b64\n    content: " + base64.StdEncoding.EncodeToString(archiveConfig) + "\n"
	if request.Key.Role == workeridentity.RoleCapture {
		installFiles += "  - path: /etc/chalk-recorder/capture-slots.env\n    permissions: \"0444\"\n    owner: root:root\n    content: CHALK_RECORDER_CAPTURE_SLOTS=" + strconv.Itoa(slotsPerNode) + "\n" +
			"  - path: /etc/systemd/system/chalk-recorder-capture.service.d/slots.conf\n    permissions: \"0444\"\n    owner: root:root\n    content: |\n      [Service]\n      EnvironmentFile=/etc/chalk-recorder/capture-slots.env\n"
	}
	workerUnit := "chalk-recorder-" + string(request.Key.Role) + ".service"
	values := []string{
		"CHALK_RECORDER_ENVIRONMENT=" + quoteEnv(request.Key.Environment),
		"CHALK_RECORDER_POOL=" + quoteEnv(string(request.Key.Role)),
		"CHALK_RECORDER_RELEASE=" + quoteEnv(request.Release.ReleaseID),
		"CHALK_RECORDER_IMAGE_DIGEST=" + quoteEnv(request.Release.ImageDigest),
		"CHALK_RECORDER_BOOTSTRAP_ENDPOINT=" + quoteEnv(request.Release.BootstrapEndpoint),
		"CHALK_RECORDER_BOOT_GENERATION=" + quoteEnv(strconv.FormatUint(request.BootGeneration, 10)),
		"CHALK_RECORDER_GPU=" + quoteEnv(strconv.FormatBool(request.Release.GPU)),
		"CHALK_RECORDER_BOOTSTRAP_ASSERTION_SOURCE=" + quoteEnv("external-reconciler"),
	}
	trust := ""
	configureTrust := ""
	if request.Release.BootstrapCABase64 != "" {
		ca, err := base64.StdEncoding.DecodeString(request.Release.BootstrapCABase64)
		roots := x509.NewCertPool()
		if err != nil || !roots.AppendCertsFromPEM(ca) {
			return "", recorderfleet.ErrInvalidConfig
		}
		endpoint, _ := url.Parse(request.Release.BootstrapEndpoint)
		trust = "  - path: /etc/chalk-recorder/bootstrap-ca.pem\n    permissions: \"0444\"\n    owner: root:root\n    encoding: b64\n    content: " + request.Release.BootstrapCABase64 + "\n"
		configureTrust = "  - [ \"/usr/bin/sed\", \"-i\", \"s/^CHALK_RECORDER_BOOTSTRAP_SERVER_NAME=.*/CHALK_RECORDER_BOOTSTRAP_SERVER_NAME=" + endpoint.Hostname() + "/\", \"/etc/chalk-recorder/image.env\" ]\n"
	}
	return "#cloud-config\nwrite_files:\n  - path: /etc/chalk-recorder/bootstrap.env\n    permissions: \"0400\"\n    owner: root:root\n    content: |\n      " + strings.Join(values, "\n      ") + "\n" + trust + installFiles + "runcmd:\n  - set -e\n  - [ \"/usr/bin/python3\", \"/run/chalk-recorder-install.py\", \"/etc/chalk-recorder/archive.json\" ]\n" + configureTrust + "  - [ \"/usr/local/sbin/chalk-recorder-bootstrap\", \"--one-time\", \"--require-signed-assertion\", \"--require-droplet-inventory-match\", \"--require-boot-generation\", \"--env-file\", \"/etc/chalk-recorder/bootstrap.env\" ]\n  - [ \"/bin/systemctl\", \"enable\", \"--now\", \"" + workerUnit + "\", \"chalk-recorder-renew.timer\" ]\n  - [ \"/usr/bin/rm\", \"-f\", \"/etc/chalk-recorder/bootstrap.env\" ]\n", nil
}

func quoteEnv(value string) string { return "'" + strings.ReplaceAll(value, "'", "'\"'\"'") + "'" }

func validDigitalOceanTag(value string) bool {
	if value == "" || len(value) > 255 {
		return false
	}
	for _, character := range value {
		if character >= 'a' && character <= 'z' || character >= 'A' && character <= 'Z' || character >= '0' && character <= '9' || strings.ContainsRune("_:-", character) {
			continue
		}
		return false
	}
	return true
}

func validOptionalIdentifier(value string) bool {
	return value == "" || strings.TrimSpace(value) == value && len(value) <= 128 && !strings.ContainsAny(value, "\r\n\x00")
}

func validSSHKeyIDs(values []int64) bool {
	if len(values) > 8 {
		return false
	}
	seen := make(map[int64]struct{}, len(values))
	for _, value := range values {
		if value <= 0 {
			return false
		}
		if _, duplicate := seen[value]; duplicate {
			return false
		}
		seen[value] = struct{}{}
	}
	return true
}
