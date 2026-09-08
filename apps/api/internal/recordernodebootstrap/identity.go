package recordernodebootstrap

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/recorderbootstrapprotocol"
)

const (
	clientCertificateName = "client-cert.pem"
	clientKeyName         = "client-key.pem"
	controlPlaneCAName    = "control-plane-ca.pem"
	renewalStateName      = "renewal.json"
)

type renewalState struct {
	SchemaVersion        string    `json:"schema_version"`
	Endpoint             string    `json:"endpoint"`
	ClientCRLEndpoint    string    `json:"client_crl_endpoint"`
	CertificateExpiresAt time.Time `json:"certificate_expires_at"`
	RenewAt              time.Time `json:"renew_at"`
}

func LoadOrCreateIdentity(directory string) (ed25519.PrivateKey, string, error) {
	if err := ensureIdentityDirectory(directory); err != nil {
		return nil, "", err
	}
	keyPath := filepath.Join(directory, clientKeyName)
	privateKey, err := readPrivateKey(keyPath)
	if errors.Is(err, os.ErrNotExist) {
		_, generated, generateErr := ed25519.GenerateKey(rand.Reader)
		if generateErr != nil {
			return nil, "", fmt.Errorf("generate recorder node identity: %w", generateErr)
		}
		encoded, marshalErr := x509.MarshalPKCS8PrivateKey(generated)
		if marshalErr != nil {
			return nil, "", fmt.Errorf("marshal recorder node identity: %w", marshalErr)
		}
		if writeErr := writeFileAtomic(keyPath, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: encoded}), 0o440); writeErr != nil {
			return nil, "", writeErr
		}
		privateKey = generated
	} else if err != nil {
		return nil, "", err
	}
	csrPEM, err := createCSR(privateKey)
	if err != nil {
		return nil, "", err
	}
	return privateKey, csrPEM, nil
}

func InstallBootstrapResponse(config Config, claims Claims, csrPEM string, response recorderbootstrapprotocol.BootstrapResponse, now time.Time) error {
	if err := ValidateBootstrapResponse(config, claims, csrPEM, response, now); err != nil {
		return err
	}
	certificatePath := filepath.Join(config.IdentityDirectory, clientCertificateName)
	certificate := appendPEM(response.ClientCertificatePEM, response.ClientCAChainPEM)
	if err := writeFileAtomic(certificatePath, []byte(certificate), 0o440); err != nil {
		return err
	}
	controlPlaneCAPath := filepath.Join(config.IdentityDirectory, controlPlaneCAName)
	if err := writeFileAtomic(controlPlaneCAPath, []byte(normalizePEM(response.ControlPlaneServerCAPEM)), 0o440); err != nil {
		return err
	}
	workerEnvironment := strings.Join([]string{
		"CHALK_RECORDER_ENVIRONMENT=" + config.Environment,
		"CHALK_RECORDER_CONTROL_PLANE_URL=" + response.ControlPlaneURL,
		"CHALK_RECORDER_WORKER_CERT=" + certificatePath,
		"CHALK_RECORDER_WORKER_KEY=" + filepath.Join(config.IdentityDirectory, clientKeyName),
		"CHALK_RECORDER_SERVER_CA=" + controlPlaneCAPath,
		"CHALK_RECORDER_SERVER_NAME=" + response.ControlPlaneServerName,
	}, "\n") + "\n"
	if err := writeFileAtomic(config.WorkerEnvironment, []byte(workerEnvironment), 0o440); err != nil {
		return err
	}
	nodeEnvironment := strings.Join([]string{
		"CHALK_RECORDER_ENVIRONMENT=" + config.Environment,
		"CHALK_RECORDER_POOL=" + string(config.Role),
		"CHALK_RECORDER_RELEASE=" + config.ReleaseID,
		"CHALK_RECORDER_IMAGE_DIGEST=" + config.ImageDigest,
		"CHALK_RECORDER_BOOTSTRAP_ENDPOINT=" + config.BootstrapEndpoint,
		fmt.Sprintf("CHALK_RECORDER_BOOT_GENERATION=%d", config.BootGeneration),
		"CHALK_RECORDER_GPU=false",
		"CHALK_RECORDER_BOOTSTRAP_ASSERTION_SOURCE=external-reconciler",
	}, "\n") + "\n"
	if err := writeFileAtomic(config.NodeEnvironment, []byte(nodeEnvironment), 0o440); err != nil {
		return err
	}
	state := renewalState{
		SchemaVersion: recorderbootstrapprotocol.RenewSchemaVersion, Endpoint: response.RenewalEndpoint,
		ClientCRLEndpoint: response.ClientCRLEndpoint, CertificateExpiresAt: response.CertificateExpiresAt,
		RenewAt: renewalTime(now, response.CertificateExpiresAt),
	}
	return writeRenewalState(config.IdentityDirectory, state)
}

func InstallRenewResponse(config Config, csrPEM string, response recorderbootstrapprotocol.RenewResponse, now time.Time) error {
	if err := ValidateRenewResponse(csrPEM, response, now); err != nil {
		return err
	}
	certificatePath := filepath.Join(config.IdentityDirectory, clientCertificateName)
	if err := writeFileAtomic(certificatePath, []byte(appendPEM(response.ClientCertificatePEM, response.ClientCAChainPEM)), 0o440); err != nil {
		return err
	}
	state, err := readRenewalState(config.IdentityDirectory)
	if err != nil {
		return err
	}
	state.CertificateExpiresAt = response.CertificateExpiresAt
	state.RenewAt = renewalTime(now, response.CertificateExpiresAt)
	return writeRenewalState(config.IdentityDirectory, state)
}

func RenewalState(directory string) (string, time.Time, error) {
	state, err := readRenewalState(directory)
	if err != nil {
		return "", time.Time{}, err
	}
	return state.Endpoint, state.RenewAt, nil
}

func IdentityPaths(directory string) (certificateFile, privateKeyFile string) {
	return filepath.Join(directory, clientCertificateName), filepath.Join(directory, clientKeyName)
}

func createCSR(privateKey ed25519.PrivateKey) (string, error) {
	encoded, err := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{Subject: pkix.Name{CommonName: "chalk-recorder-node"}}, privateKey)
	if err != nil {
		return "", fmt.Errorf("create recorder node csr: %w", err)
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE REQUEST", Bytes: encoded})), nil
}

func readPrivateKey(path string) (ed25519.PrivateKey, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	block, rest := pem.Decode(data)
	if block == nil || block.Type != "PRIVATE KEY" || len(strings.TrimSpace(string(rest))) != 0 {
		return nil, ErrInvalidConfig
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, ErrInvalidConfig
	}
	privateKey, ok := parsed.(ed25519.PrivateKey)
	if !ok || len(privateKey) != ed25519.PrivateKeySize {
		return nil, ErrInvalidConfig
	}
	return privateKey, nil
}

func ensureIdentityDirectory(path string) error {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return ErrInvalidConfig
	}
	info, err := os.Lstat(path)
	if err != nil || !info.IsDir() || info.Mode().Perm()&0o007 != 0 {
		return fmt.Errorf("%w: unsafe identity directory", ErrInvalidConfig)
	}
	return nil
}

func writeRenewalState(directory string, state renewalState) error {
	data, err := json.Marshal(state)
	if err != nil {
		return ErrInvalidConfig
	}
	data = append(data, '\n')
	return writeFileAtomic(filepath.Join(directory, renewalStateName), data, 0o600)
}

func readRenewalState(directory string) (renewalState, error) {
	data, err := os.ReadFile(filepath.Join(directory, renewalStateName))
	if err != nil || len(data) > 16<<10 {
		return renewalState{}, ErrInvalidConfig
	}
	var state renewalState
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&state) != nil || state.SchemaVersion != recorderbootstrapprotocol.RenewSchemaVersion || !validHTTPSURL(state.Endpoint) || !validHTTPSURL(state.ClientCRLEndpoint) || state.CertificateExpiresAt.IsZero() || state.RenewAt.IsZero() || !state.RenewAt.Before(state.CertificateExpiresAt) {
		return renewalState{}, ErrInvalidConfig
	}
	return state, nil
}

func renewalTime(now, expiresAt time.Time) time.Time {
	return expiresAt.Add(-expiresAt.Sub(now) / 3)
}

func writeFileAtomic(path string, data []byte, mode os.FileMode) error {
	directory := filepath.Dir(path)
	file, err := os.CreateTemp(directory, ".chalk-recorder-*")
	if err != nil {
		return fmt.Errorf("create temporary recorder identity file: %w", err)
	}
	temporary := file.Name()
	defer os.Remove(temporary)
	if err := file.Chmod(mode); err != nil {
		file.Close()
		return fmt.Errorf("set recorder identity file permissions: %w", err)
	}
	if _, err := file.Write(data); err != nil {
		file.Close()
		return fmt.Errorf("write recorder identity file: %w", err)
	}
	if err := file.Sync(); err != nil {
		file.Close()
		return fmt.Errorf("sync recorder identity file: %w", err)
	}
	if err := file.Close(); err != nil {
		return fmt.Errorf("close recorder identity file: %w", err)
	}
	if err := os.Rename(temporary, path); err != nil {
		return fmt.Errorf("install recorder identity file: %w", err)
	}
	return nil
}

func appendPEM(leaf, chain string) string {
	return normalizePEM(leaf) + normalizePEM(chain)
}

func normalizePEM(value string) string {
	return strings.TrimSpace(value) + "\n"
}
