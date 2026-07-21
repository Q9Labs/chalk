package apikeys

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"io"
	"strings"
)

const (
	rawKeyMarker    = "chalk_sk_"
	prefixByteCount = 9
	secretByteCount = 32
)

type credential struct {
	prefix string
	secret string
	raw    string
	hash   string
}

func newCredential(random io.Reader) (credential, error) {
	prefixBytes := make([]byte, prefixByteCount)
	if _, err := io.ReadFull(random, prefixBytes); err != nil {
		return credential{}, err
	}

	secretBytes := make([]byte, secretByteCount)
	if _, err := io.ReadFull(random, secretBytes); err != nil {
		return credential{}, err
	}

	prefix := base64.RawURLEncoding.EncodeToString(prefixBytes)
	secret := base64.RawURLEncoding.EncodeToString(secretBytes)
	return credential{
		prefix: prefix,
		secret: secret,
		raw:    rawKeyMarker + prefix + "." + secret,
		hash:   credentialHash(rawKeyMarker + prefix + "." + secret),
	}, nil
}

func parseCredential(raw string) (string, string, bool) {
	if !strings.HasPrefix(raw, rawKeyMarker) {
		return "", "", false
	}

	parts := strings.Split(strings.TrimPrefix(raw, rawKeyMarker), ".")
	if len(parts) != 2 || !validEncodedPart(parts[0], prefixByteCount) || !validEncodedPart(parts[1], secretByteCount) {
		return "", "", false
	}

	return parts[0], parts[1], true
}

func validEncodedPart(value string, byteCount int) bool {
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	return err == nil && len(decoded) == byteCount && base64.RawURLEncoding.EncodeToString(decoded) == value
}

func credentialHash(raw string) string {
	digest := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(digest[:])
}

func credentialMatches(raw, encodedHash string) bool {
	expected := make([]byte, sha256.Size)
	decoded, err := hex.DecodeString(encodedHash)
	validHash := subtle.ConstantTimeEq(int32(len(decoded)), sha256.Size)
	if len(decoded) == sha256.Size {
		copy(expected, decoded)
	}

	actual := sha256.Sum256([]byte(raw))
	return subtle.ConstantTimeCompare(actual[:], expected) == 1 && validHash == 1 && err == nil
}
