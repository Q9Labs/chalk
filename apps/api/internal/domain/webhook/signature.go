package webhook

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
)

// GenerateSignature creates an HMAC-SHA256 signature for webhook payload.
// Format: sha256=hmac(secret, "timestamp.payload")
func GenerateSignature(secret string, timestamp int64, payload []byte) string {
	message := fmt.Sprintf("%d.%s", timestamp, string(payload))
	h := hmac.New(sha256.New, []byte(secret))
	h.Write([]byte(message))
	return "sha256=" + hex.EncodeToString(h.Sum(nil))
}

// VerifySignature validates an incoming webhook signature.
func VerifySignature(secret string, timestamp int64, payload []byte, signature string) bool {
	expected := GenerateSignature(secret, timestamp, payload)
	return hmac.Equal([]byte(expected), []byte(signature))
}

// GenerateSecret creates a new webhook secret using crypto/rand.
// Returns a 32-byte hex-encoded string prefixed with "whsec_".
func GenerateSecret() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("failed to generate random bytes: %w", err)
	}
	return "whsec_" + hex.EncodeToString(b), nil
}
