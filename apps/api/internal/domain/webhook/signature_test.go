package webhook

import (
	"strings"
	"testing"
)

func TestGenerateSignature(t *testing.T) {
	secret := "whsec_test_secret"
	timestamp := int64(1704067200)
	payload := []byte(`{"event":"meeting.recording_ready","meeting":{"id":"abc123"}}`)

	signature := GenerateSignature(secret, timestamp, payload)

	// Verify signature format
	if !strings.HasPrefix(signature, "sha256=") {
		t.Errorf("expected signature to start with 'sha256=', got %s", signature)
	}

	// Verify signature length (sha256= prefix + 64 hex chars)
	if len(signature) != 7+64 {
		t.Errorf("expected signature length 71, got %d", len(signature))
	}
}

func TestVerifySignature(t *testing.T) {
	secret := "whsec_test_secret"
	timestamp := int64(1704067200)
	payload := []byte(`{"event":"meeting.recording_ready"}`)

	// Generate signature
	signature := GenerateSignature(secret, timestamp, payload)

	// Verify correct signature
	if !VerifySignature(secret, timestamp, payload, signature) {
		t.Error("expected valid signature to verify")
	}

	// Verify incorrect secret fails
	if VerifySignature("wrong_secret", timestamp, payload, signature) {
		t.Error("expected wrong secret to fail verification")
	}

	// Verify incorrect timestamp fails
	if VerifySignature(secret, timestamp+1, payload, signature) {
		t.Error("expected wrong timestamp to fail verification")
	}

	// Verify incorrect payload fails
	if VerifySignature(secret, timestamp, []byte("wrong payload"), signature) {
		t.Error("expected wrong payload to fail verification")
	}
}

func TestGenerateSecret(t *testing.T) {
	secret1, err := GenerateSecret()
	if err != nil {
		t.Fatalf("failed to generate secret: %v", err)
	}

	// Verify prefix
	if !strings.HasPrefix(secret1, "whsec_") {
		t.Errorf("expected secret to start with 'whsec_', got %s", secret1)
	}

	// Verify length (whsec_ prefix + 64 hex chars from 32 bytes)
	if len(secret1) != 6+64 {
		t.Errorf("expected secret length 70, got %d", len(secret1))
	}

	// Verify uniqueness
	secret2, err := GenerateSecret()
	if err != nil {
		t.Fatalf("failed to generate second secret: %v", err)
	}

	if secret1 == secret2 {
		t.Error("expected different secrets to be generated")
	}
}
