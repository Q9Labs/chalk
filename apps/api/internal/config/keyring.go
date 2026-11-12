package config

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
)

// parseEd25519PrivateKey reads an unpadded base64url Ed25519 private key and
// returns it with its public half.
func parseEd25519PrivateKey(envName, encoded string) (ed25519.PrivateKey, ed25519.PublicKey, error) {
	raw, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil || len(raw) != ed25519.PrivateKeySize {
		return nil, nil, fmt.Errorf("%s must be an unpadded base64url Ed25519 private key", envName)
	}
	privateKey := ed25519.PrivateKey(raw)
	return privateKey, append(ed25519.PublicKey(nil), privateKey[ed25519.SeedSize:]...), nil
}

// parseEd25519Keyring reads a JSON object of key IDs to unpadded base64url
// Ed25519 public keys. validKeyID rejects an ID the caller cannot use.
func parseEd25519Keyring(envName, encoded string, validKeyID func(string) error) (map[string]ed25519.PublicKey, error) {
	var keyring map[string]string
	if err := json.Unmarshal([]byte(encoded), &keyring); err != nil || len(keyring) == 0 {
		return nil, fmt.Errorf("%s must be a non-empty JSON object of key IDs to unpadded base64url Ed25519 public keys", envName)
	}
	keys := make(map[string]ed25519.PublicKey, len(keyring))
	for keyID, encodedKey := range keyring {
		keyID = strings.TrimSpace(keyID)
		if err := validKeyID(keyID); err != nil {
			return nil, fmt.Errorf("%s contains an invalid key ID", envName)
		}
		publicKey, err := base64.RawURLEncoding.DecodeString(strings.TrimSpace(encodedKey))
		if err != nil || len(publicKey) != ed25519.PublicKeySize {
			return nil, fmt.Errorf("%s contains an invalid Ed25519 public key", envName)
		}
		keys[keyID] = publicKey
	}
	return keys, nil
}

// requireCurrentKey fails unless the keyring holds the current public key
// under the current key ID.
func requireCurrentKey(envName, keyIDName, keyID string, keys map[string]ed25519.PublicKey, current ed25519.PublicKey) error {
	configured, ok := keys[keyID]
	if !ok || !configured.Equal(current) {
		return fmt.Errorf("%s must contain the current %s public key", envName, keyIDName)
	}
	return nil
}
