package config

import (
	"bufio"
	"crypto/ed25519"
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The host environment contracts (infrastructure/managed-episode/env) document every variable the controller renders into the
// host. A release that makes a new variable required would otherwise first fail on the host, so each contract must load through
// Load() as it stands. A value an operator supplies from the secret store is replaced by a well-formed stand-in.
func TestHostEnvironmentContractsLoad(t *testing.T) {
	for _, name := range []string{"api.nightly.env.example", "api.env.example"} {
		t.Run(name, func(t *testing.T) {
			values := readEnvContract(t, filepath.Join("..", "..", "..", "..", "infrastructure", "managed-episode", "env", name))
			// The controller adds these three at deploy time (chalk-deployment-controller, set_env_value).
			if _, recorderFleet := values["CHALK_RECORDER_FLEET_ISSUER_URL"]; recorderFleet {
				values["CHALK_RECORDER_FLEET_ISSUER_CLIENT_CERT"] = "/run/chalk/recorder-issuer.crt"
				values["CHALK_RECORDER_FLEET_ISSUER_CLIENT_KEY"] = "/run/chalk/recorder-issuer.key"
				values["CHALK_RECORDER_FLEET_ISSUER_SERVER_CA"] = "/run/chalk/recorder-issuer-ca.crt"
			}
			keys := standInKeys(t)
			for key, value := range values {
				t.Setenv(key, keys.standIn(key, value))
			}
			if _, err := Load(); err != nil {
				t.Fatalf("%s does not load: %v", name, err)
			}
		})
	}
}

func readEnvContract(t *testing.T, path string) map[string]string {
	t.Helper()
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	values := map[string]string{}
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			t.Fatalf("%s: line without =: %q", path, line)
		}
		values[key] = value
	}
	if err := scanner.Err(); err != nil {
		t.Fatal(err)
	}
	return values
}

type standInKeyPairs struct{ sync, invite ed25519.PrivateKey }

func standInKeys(t *testing.T) standInKeyPairs {
	t.Helper()
	var pairs standInKeyPairs
	for _, target := range []*ed25519.PrivateKey{&pairs.sync, &pairs.invite} {
		_, private, err := ed25519.GenerateKey(nil)
		if err != nil {
			t.Fatal(err)
		}
		*target = private
	}
	return pairs
}

// standIn returns the value to load for a contract line. A placeholder (__NAME__) stands for a value the host gets elsewhere; a
// variable the loader checks the shape of needs a value of that shape, and the others take a plain string. Every key id stands
// in as "contract-value", so a keyring names it.
func (keys standInKeyPairs) standIn(key, value string) string {
	if !strings.Contains(value, "__") {
		return value
	}
	encode := base64.RawURLEncoding.EncodeToString
	keyring := func(private ed25519.PrivateKey) string {
		return `{"contract-value":"` + encode(private.Public().(ed25519.PublicKey)) + `"}`
	}
	switch key {
	case "CHALK_SYNC_TOKEN_PRIVATE_KEY":
		return encode(keys.sync)
	case "CHALK_PUBLIC_INVITE_PRIVATE_KEY":
		return encode(keys.invite)
	case "CHALK_MEDIA_TOKEN_VERIFICATION_KEYS":
		return keyring(keys.sync)
	case "CHALK_PUBLIC_INVITE_VERIFICATION_KEYS":
		return keyring(keys.invite)
	case "CHALK_WEBHOOK_ENCRYPTION_KEY":
		return base64.StdEncoding.EncodeToString(make([]byte, 32))
	case "CHALK_TRANSCRIPTION_WORKLOAD_AUTH_SECRET":
		return strings.Repeat("s", 32)
	case "CHALK_DATABASE_URL":
		return "postgres://contract:contract@db.invalid:5432/chalk?sslmode=verify-full"
	case "CHALK_SFU_NODES":
		return "contract=https://sfu.invalid:8443"
	case "CHALK_PUBLIC_INVITE_MANAGED_TENANT_ID":
		return "00000000-0000-4000-8000-000000000001"
	}
	if strings.HasPrefix(value, "__RELEASE_ID__") {
		return "contract-release"
	}
	return "contract-value"
}
