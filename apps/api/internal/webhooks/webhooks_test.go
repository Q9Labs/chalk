package webhooks

import (
	"encoding/base64"
	"encoding/json"
	"net/netip"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestStandardWebhookSignatureMatchesGoldenVector(t *testing.T) {
	body, err := os.ReadFile("../../../../contract/webhooks/v1/signature-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var vector struct {
		WebhookID        string `json:"webhook_id"`
		WebhookTimestamp string `json:"webhook_timestamp"`
		BodyUTF8         string `json:"body_utf8"`
		Secrets          []struct {
			Value     string
			Signature string
		}
	}
	if err := json.Unmarshal(body, &vector); err != nil {
		t.Fatal(err)
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(vector.Secrets[0].Value, "whsec_"))
	if err != nil {
		t.Fatal(err)
	}
	timestampSeconds, _ := strconv.ParseInt(vector.WebhookTimestamp, 10, 64)
	timestamp, signature := SignatureHeader(vector.WebhookID, time.Unix(timestampSeconds, 0), []byte(vector.BodyUTF8), raw)
	if timestamp != vector.WebhookTimestamp || signature != vector.Secrets[0].Signature {
		t.Fatalf("signature %q at %q", signature, timestamp)
	}
}

func TestEndpointURLAndAddressPolicy(t *testing.T) {
	normalized, redacted, err := ValidateEndpointURL("https://Hooks.Example.com/chalk?token=secret")
	if err != nil {
		t.Fatal(err)
	}
	if normalized != "https://hooks.example.com/chalk?token=secret" || redacted != "https://hooks.example.com/chalk?REDACTED" {
		t.Fatalf("normalized=%q redacted=%q", normalized, redacted)
	}
	for _, value := range []string{"127.0.0.1", "10.0.0.1", "169.254.169.254", "100.64.0.1"} {
		if PublicAddress(netip.MustParseAddr(value)) {
			t.Fatalf("address %s allowed", value)
		}
	}
	for _, value := range []string{"1.1.1.1", "2606:4700:4700::1111"} {
		if !PublicAddress(netip.MustParseAddr(value)) {
			t.Fatalf("public address %s rejected", value)
		}
	}
}

func TestAESGCMKeyringDecryptsOldVersionsAndWritesCurrentVersion(t *testing.T) {
	oldKey := make([]byte, 32)
	newKey := make([]byte, 32)
	newKey[0] = 1
	oldProtector, err := NewAESGCMKeyring(1, map[byte][]byte{1: oldKey})
	if err != nil {
		t.Fatal(err)
	}
	oldCiphertext, err := oldProtector.Protect("scope", []byte("old secret"))
	if err != nil {
		t.Fatal(err)
	}
	rotatedProtector, err := NewAESGCMKeyring(2, map[byte][]byte{1: oldKey, 2: newKey})
	if err != nil {
		t.Fatal(err)
	}
	plaintext, err := rotatedProtector.Unprotect("scope", oldCiphertext)
	if err != nil || string(plaintext) != "old secret" {
		t.Fatalf("old plaintext = %q, error = %v", plaintext, err)
	}
	newCiphertext, err := rotatedProtector.Protect("scope", []byte("new secret"))
	if err != nil {
		t.Fatal(err)
	}
	if len(newCiphertext) < 2 || newCiphertext[1] != 2 {
		t.Fatalf("ciphertext key version = %v, want 2", newCiphertext)
	}
	if _, err := oldProtector.Unprotect("scope", newCiphertext); err == nil {
		t.Fatal("old-only keyring decrypted current-version ciphertext")
	}
}
