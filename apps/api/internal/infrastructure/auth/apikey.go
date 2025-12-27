package auth

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"

	"golang.org/x/crypto/bcrypt"
)

var (
	ErrInvalidAPIKey = errors.New("invalid API key format")
)

const (
	// API key format: ck_live_<32 random bytes base64>
	APIKeyPrefix     = "ck_live_"
	APIKeyTestPrefix = "ck_test_"
	APIKeyLength     = 32
)

// APIKeyService handles API key operations
type APIKeyService struct {
	bcryptCost int
}

// NewAPIKeyService creates a new API key service
func NewAPIKeyService() *APIKeyService {
	return &APIKeyService{
		bcryptCost: bcrypt.DefaultCost,
	}
}

// GenerateAPIKey creates a new API key and its hash
// Returns (plaintext_key, hashed_key, error)
func (s *APIKeyService) GenerateAPIKey(isTest bool) (string, string, error) {
	// Generate random bytes
	randomBytes := make([]byte, APIKeyLength)
	if _, err := rand.Read(randomBytes); err != nil {
		return "", "", fmt.Errorf("failed to generate random bytes: %w", err)
	}

	// Create the key
	prefix := APIKeyPrefix
	if isTest {
		prefix = APIKeyTestPrefix
	}
	plainKey := prefix + base64.RawURLEncoding.EncodeToString(randomBytes)

	// Hash the key
	hash, err := s.HashAPIKey(plainKey)
	if err != nil {
		return "", "", err
	}

	return plainKey, hash, nil
}

// HashAPIKey creates a bcrypt hash of an API key
func (s *APIKeyService) HashAPIKey(apiKey string) (string, error) {
	hash, err := bcrypt.GenerateFromPassword([]byte(apiKey), s.bcryptCost)
	if err != nil {
		return "", fmt.Errorf("failed to hash API key: %w", err)
	}
	return string(hash), nil
}

// VerifyAPIKey checks if an API key matches a hash
func (s *APIKeyService) VerifyAPIKey(apiKey, hash string) bool {
	err := bcrypt.CompareHashAndPassword([]byte(hash), []byte(apiKey))
	return err == nil
}

// ValidateAPIKeyFormat checks if an API key has the correct format
func (s *APIKeyService) ValidateAPIKeyFormat(apiKey string) error {
	if !strings.HasPrefix(apiKey, APIKeyPrefix) && !strings.HasPrefix(apiKey, APIKeyTestPrefix) {
		return ErrInvalidAPIKey
	}

	// Check minimum length
	minLength := len(APIKeyPrefix) + 20 // prefix + at least 20 chars
	if len(apiKey) < minLength {
		return ErrInvalidAPIKey
	}

	return nil
}

// IsTestKey checks if an API key is a test key
func (s *APIKeyService) IsTestKey(apiKey string) bool {
	return strings.HasPrefix(apiKey, APIKeyTestPrefix)
}
