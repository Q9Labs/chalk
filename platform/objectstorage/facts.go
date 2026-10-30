package objectstorage

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
)

// ObjectSHA256 returns the provider checksum or Chalk's immutable checksum
// metadata after enforcing the one SHA-256 wire representation.
func ObjectSHA256(facts ObjectFacts) ([]byte, error) {
	if facts.ChecksumSHA256 != "" {
		decoded, err := base64.StdEncoding.Strict().DecodeString(facts.ChecksumSHA256)
		if err != nil || len(decoded) != sha256.Size {
			return nil, ErrInvalidChecksum
		}
		return decoded, nil
	}
	if value := facts.Metadata["chalk-sha256"]; value != "" {
		decoded, err := hex.DecodeString(value)
		if err != nil || len(decoded) != sha256.Size {
			return nil, ErrInvalidChecksum
		}
		return decoded, nil
	}
	return nil, ErrInvalidChecksum
}
