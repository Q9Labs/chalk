package webhooks

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"io"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type SecretProtector interface {
	Protect(scope string, plaintext []byte) ([]byte, error)
	Unprotect(scope string, ciphertext []byte) ([]byte, error)
}

type AESGCMProtector struct {
	currentVersion byte
	keys           map[byte]cipher.AEAD
	random         io.Reader
}

func NewAESGCMProtector(key []byte) (*AESGCMProtector, error) {
	if len(key) != 32 {
		return nil, errors.New("webhook encryption key must be 32 bytes")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("create webhook cipher: %w", err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("create webhook authenticated cipher: %w", err)
	}
	return &AESGCMProtector{currentVersion: 1, keys: map[byte]cipher.AEAD{1: aead}, random: rand.Reader}, nil
}

func NewAESGCMKeyring(currentVersion byte, keys map[byte][]byte) (*AESGCMProtector, error) {
	if currentVersion == 0 {
		return nil, errors.New("webhook encryption key version must be positive")
	}
	result := &AESGCMProtector{currentVersion: currentVersion, keys: make(map[byte]cipher.AEAD, len(keys)), random: rand.Reader}
	for version, key := range keys {
		if version == 0 {
			return nil, errors.New("webhook encryption key version must be positive")
		}
		if len(key) != 32 {
			return nil, errors.New("webhook encryption key must be 32 bytes")
		}
		block, err := aes.NewCipher(key)
		if err != nil {
			return nil, err
		}
		aead, err := cipher.NewGCM(block)
		if err != nil {
			return nil, err
		}
		result.keys[version] = aead
	}
	if result.keys[currentVersion] == nil {
		return nil, errors.New("current webhook encryption key version is missing")
	}
	return result, nil
}

func (p *AESGCMProtector) Protect(scope string, plaintext []byte) ([]byte, error) {
	aead := p.keys[p.currentVersion]
	nonce := make([]byte, aead.NonceSize())
	if _, err := io.ReadFull(p.random, nonce); err != nil {
		return nil, fmt.Errorf("generate webhook nonce: %w", err)
	}
	envelope := []byte{1, p.currentVersion}
	envelope = append(envelope, nonce...)
	return aead.Seal(envelope, envelope[2:], plaintext, []byte(scope)), nil
}

func (p *AESGCMProtector) Unprotect(scope string, ciphertext []byte) ([]byte, error) {
	if len(ciphertext) < 2 || ciphertext[0] != 1 {
		return nil, errors.New("invalid webhook ciphertext")
	}
	aead := p.keys[ciphertext[1]]
	if aead == nil {
		return nil, errors.New("unknown webhook encryption key version")
	}
	nonceSize := aead.NonceSize()
	if len(ciphertext) < 2+nonceSize {
		return nil, errors.New("invalid webhook ciphertext")
	}
	plaintext, err := aead.Open(nil, ciphertext[2:2+nonceSize], ciphertext[2+nonceSize:], []byte(scope))
	if err != nil {
		return nil, errors.New("invalid webhook ciphertext")
	}
	return plaintext, nil
}

func SecretScope(tenantID, endpointID utilities.ID) string {
	return "webhook/tenant/" + tenantID.String() + "/endpoint/" + endpointID.String() + "/signing-secret"
}
func URLScope(tenantID, endpointID, targetRevisionID utilities.ID) string {
	return "webhook/tenant/" + tenantID.String() + "/endpoint/" + endpointID.String() + "/target-revision/" + targetRevisionID.String() + "/url"
}
func IdempotencyScope(tenantID utilities.ID, operation, key string) string {
	return "webhook/tenant/" + tenantID.String() + "/idempotency/" + operation + "/" + key
}

func DecodeEncryptionKey(value string) ([]byte, error) {
	key, err := base64.StdEncoding.DecodeString(value)
	if err != nil || len(key) != 32 {
		return nil, errors.New("webhook encryption key must be base64-encoded 32 bytes")
	}
	return key, nil
}
