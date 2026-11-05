package mcpauth

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"strings"
)

const (
	AccessTokenPrefix  = "chalk_oat_"
	refreshTokenPrefix = "chalk_ort_"
	codePrefix         = "chalk_oac_"
	handlePrefix       = "chalk_oar_"
	clientIDPrefix     = "chalk_mcp_"
)

// newSecret returns a 256-bit random value with a type prefix and its hash.
// Only the hash is stored.
func newSecret(prefix string) (raw, hash string, err error) {
	buffer := make([]byte, 32)
	if _, err := rand.Read(buffer); err != nil {
		return "", "", fmt.Errorf("read random bytes: %w", err)
	}
	raw = prefix + base64.RawURLEncoding.EncodeToString(buffer)
	return raw, hashSecret(raw), nil
}

func hashSecret(raw string) string {
	digest := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(digest[:])
}

// HashAccessToken hashes a presented bearer value, or reports it is not an OAuth access token.
func HashAccessToken(raw string) (string, bool) {
	if !strings.HasPrefix(raw, AccessTokenPrefix) || len(raw) > 128 {
		return "", false
	}
	return hashSecret(raw), true
}

// verifyPKCE implements the S256 method only; "plain" is never accepted.
func verifyPKCE(verifier, challenge string) bool {
	if len(verifier) < 43 || len(verifier) > 128 {
		return false
	}
	for _, r := range verifier {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '.' || r == '_' || r == '~') {
			return false
		}
	}
	digest := sha256.Sum256([]byte(verifier))
	expected := base64.RawURLEncoding.EncodeToString(digest[:])
	return subtle.ConstantTimeCompare([]byte(expected), []byte(challenge)) == 1
}

func validCodeChallenge(challenge string) bool {
	decoded, err := base64.RawURLEncoding.DecodeString(challenge)
	return err == nil && len(decoded) == sha256.Size && base64.RawURLEncoding.EncodeToString(decoded) == challenge
}
