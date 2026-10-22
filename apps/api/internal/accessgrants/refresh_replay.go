package accessgrants

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"fmt"
)

type RefreshReplay struct {
	RequestHash [32]byte
	Ciphertext  []byte
}

func RefreshRequestHash(token string) [32]byte {
	return sha256.Sum256([]byte("chalk-access-refresh-request-v1:" + token))
}

func refreshReplayCipher(token string) (cipher.AEAD, error) {
	// Keep the encryption key distinct from the request hash stored in Postgres.
	key := sha256.Sum256([]byte("chalk-access-refresh-response-v1:" + token))
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

func SealRefreshReplay(token string, response []byte) (RefreshReplay, error) {
	aead, err := refreshReplayCipher(token)
	if err != nil {
		return RefreshReplay{}, err
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return RefreshReplay{}, fmt.Errorf("create refresh replay nonce: %w", err)
	}
	requestHash := RefreshRequestHash(token)
	return RefreshReplay{RequestHash: requestHash, Ciphertext: aead.Seal(nonce, nonce, response, requestHash[:])}, nil
}

func OpenRefreshReplay(token string, ciphertext []byte) ([]byte, error) {
	aead, err := refreshReplayCipher(token)
	if err != nil {
		return nil, err
	}
	if len(ciphertext) < aead.NonceSize() {
		return nil, fmt.Errorf("invalid refresh replay ciphertext")
	}
	requestHash := RefreshRequestHash(token)
	return aead.Open(nil, ciphertext[:aead.NonceSize()], ciphertext[aead.NonceSize():], requestHash[:])
}
