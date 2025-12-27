package auth

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"golang.org/x/crypto/bcrypt"
)

func TestAPIKeyService_GenerateAPIKey_Live(t *testing.T) {
	svc := NewAPIKeyService()

	plainKey, hash, err := svc.GenerateAPIKey(false)

	require.NoError(t, err)
	assert.NotEmpty(t, plainKey)
	assert.NotEmpty(t, hash)
	assert.True(t, strings.HasPrefix(plainKey, APIKeyPrefix))
	assert.True(t, len(plainKey) > len(APIKeyPrefix)+20)
}

func TestAPIKeyService_GenerateAPIKey_Test(t *testing.T) {
	svc := NewAPIKeyService()

	plainKey, hash, err := svc.GenerateAPIKey(true)

	require.NoError(t, err)
	assert.NotEmpty(t, plainKey)
	assert.NotEmpty(t, hash)
	assert.True(t, strings.HasPrefix(plainKey, APIKeyTestPrefix))
	assert.True(t, len(plainKey) > len(APIKeyTestPrefix)+20)
}

func TestAPIKeyService_GenerateAPIKey_GeneratesUnique(t *testing.T) {
	svc := NewAPIKeyService()

	key1, _, err1 := svc.GenerateAPIKey(false)
	key2, _, err2 := svc.GenerateAPIKey(false)

	require.NoError(t, err1)
	require.NoError(t, err2)
	assert.NotEqual(t, key1, key2)
}

func TestAPIKeyService_GenerateAPIKey_ProducesValidHash(t *testing.T) {
	svc := NewAPIKeyService()

	plainKey, hash, err := svc.GenerateAPIKey(false)
	require.NoError(t, err)

	// Verify the hash is valid bcrypt
	err = bcrypt.CompareHashAndPassword([]byte(hash), []byte(plainKey))
	assert.NoError(t, err)
}

func TestAPIKeyService_HashAPIKey(t *testing.T) {
	svc := NewAPIKeyService()

	apiKey := "ck_live_abcdefghijklmnopqrstuvwxyz123456"
	hash, err := svc.HashAPIKey(apiKey)

	require.NoError(t, err)
	assert.NotEmpty(t, hash)
	assert.NotEqual(t, apiKey, hash)
}

func TestAPIKeyService_HashAPIKey_ProducesBcryptHash(t *testing.T) {
	svc := NewAPIKeyService()

	apiKey := "ck_live_abcdefghijklmnopqrstuvwxyz123456"
	hash, err := svc.HashAPIKey(apiKey)

	require.NoError(t, err)
	// Bcrypt hashes start with $2a$, $2b$, $2x$, or $2y$
	assert.True(t, strings.HasPrefix(hash, "$2"))
}

func TestAPIKeyService_HashAPIKey_ConsistentFormat(t *testing.T) {
	svc := NewAPIKeyService()

	apiKey := "ck_live_test123"

	hash1, err1 := svc.HashAPIKey(apiKey)
	hash2, err2 := svc.HashAPIKey(apiKey)

	require.NoError(t, err1)
	require.NoError(t, err2)

	// Different hashes (bcrypt includes salt), but both should verify against the same key
	err1 = bcrypt.CompareHashAndPassword([]byte(hash1), []byte(apiKey))
	err2 = bcrypt.CompareHashAndPassword([]byte(hash2), []byte(apiKey))
	assert.NoError(t, err1)
	assert.NoError(t, err2)
}

func TestAPIKeyService_VerifyAPIKey_Valid(t *testing.T) {
	svc := NewAPIKeyService()

	apiKey := "ck_live_abcdefghijklmnopqrstuvwxyz123456"
	hash, err := svc.HashAPIKey(apiKey)
	require.NoError(t, err)

	result := svc.VerifyAPIKey(apiKey, hash)

	assert.True(t, result)
}

func TestAPIKeyService_VerifyAPIKey_Invalid(t *testing.T) {
	svc := NewAPIKeyService()

	apiKey := "ck_live_abcdefghijklmnopqrstuvwxyz123456"
	wrongKey := "ck_live_different_key_xyz123"

	hash, err := svc.HashAPIKey(apiKey)
	require.NoError(t, err)

	result := svc.VerifyAPIKey(wrongKey, hash)

	assert.False(t, result)
}

func TestAPIKeyService_VerifyAPIKey_EmptyString(t *testing.T) {
	svc := NewAPIKeyService()

	apiKey := "ck_live_abcdefghijklmnopqrstuvwxyz123456"
	hash, err := svc.HashAPIKey(apiKey)
	require.NoError(t, err)

	result := svc.VerifyAPIKey("", hash)

	assert.False(t, result)
}

func TestAPIKeyService_VerifyAPIKey_InvalidHash(t *testing.T) {
	svc := NewAPIKeyService()

	apiKey := "ck_live_abcdefghijklmnopqrstuvwxyz123456"
	invalidHash := "not_a_valid_bcrypt_hash"

	result := svc.VerifyAPIKey(apiKey, invalidHash)

	assert.False(t, result)
}

func TestAPIKeyService_VerifyAPIKey_RoundTrip(t *testing.T) {
	svc := NewAPIKeyService()

	plainKey, hash, err := svc.GenerateAPIKey(false)
	require.NoError(t, err)

	result := svc.VerifyAPIKey(plainKey, hash)

	assert.True(t, result)
}

func TestAPIKeyService_ValidateAPIKeyFormat_ValidLiveKey(t *testing.T) {
	svc := NewAPIKeyService()

	testCases := []string{
		"ck_live_abcdefghijklmnopqrstuvwxyz1234567890",
		"ck_live_aA1!@#$%^&*()-=_+[]{}|;:,.<>?/",
		"ck_live_x",
		"ck_live_" + strings.Repeat("a", 100),
	}

	for _, key := range testCases {
		if len(key) >= len(APIKeyPrefix)+20 {
			t.Run("valid_"+key[:min(len(key), 20)], func(t *testing.T) {
				err := svc.ValidateAPIKeyFormat(key)
				assert.NoError(t, err)
			})
		}
	}
}

func TestAPIKeyService_ValidateAPIKeyFormat_ValidTestKey(t *testing.T) {
	svc := NewAPIKeyService()

	testCases := []string{
		"ck_test_abcdefghijklmnopqrstuvwxyz1234567890",
		"ck_test_aA1!@#$%^&*()-=_+[]{}|;:,.<>?/",
		"ck_test_verylongstring" + strings.Repeat("x", 50),
	}

	for _, key := range testCases {
		if len(key) >= len(APIKeyTestPrefix)+20 {
			t.Run("valid_test_"+key[:min(len(key), 20)], func(t *testing.T) {
				err := svc.ValidateAPIKeyFormat(key)
				assert.NoError(t, err)
			})
		}
	}
}

func TestAPIKeyService_ValidateAPIKeyFormat_InvalidPrefix(t *testing.T) {
	svc := NewAPIKeyService()

	testCases := []string{
		"ck_invalid_key",
		"invalid_ck_live_key",
		"ck_livekey",
		"ck_tester_key",
		"sk_live_key",
	}

	for _, key := range testCases {
		t.Run("invalid_prefix_"+key, func(t *testing.T) {
			err := svc.ValidateAPIKeyFormat(key)
			assert.Error(t, err)
			assert.Equal(t, ErrInvalidAPIKey, err)
		})
	}
}

func TestAPIKeyService_ValidateAPIKeyFormat_TooShort(t *testing.T) {
	svc := NewAPIKeyService()

	testCases := []string{
		"ck_live_abc",    // Too short
		"ck_test_short",  // Too short
		"ck_live_",       // Just prefix
		"ck_test_",       // Just prefix
	}

	for _, key := range testCases {
		t.Run("too_short_"+key, func(t *testing.T) {
			err := svc.ValidateAPIKeyFormat(key)
			assert.Error(t, err)
			assert.Equal(t, ErrInvalidAPIKey, err)
		})
	}
}

func TestAPIKeyService_ValidateAPIKeyFormat_Empty(t *testing.T) {
	svc := NewAPIKeyService()

	err := svc.ValidateAPIKeyFormat("")

	assert.Error(t, err)
	assert.Equal(t, ErrInvalidAPIKey, err)
}

func TestAPIKeyService_IsTestKey_TestKey(t *testing.T) {
	svc := NewAPIKeyService()

	result := svc.IsTestKey("ck_test_abcdefghijklmnopqrstuvwxyz")

	assert.True(t, result)
}

func TestAPIKeyService_IsTestKey_LiveKey(t *testing.T) {
	svc := NewAPIKeyService()

	result := svc.IsTestKey("ck_live_abcdefghijklmnopqrstuvwxyz")

	assert.False(t, result)
}

func TestAPIKeyService_IsTestKey_InvalidKey(t *testing.T) {
	svc := NewAPIKeyService()

	testCases := []string{
		"ck_invalid_key",
		"sk_live_key",
		"test_key",
		"",
	}

	for _, key := range testCases {
		t.Run("invalid_"+key, func(t *testing.T) {
			result := svc.IsTestKey(key)
			assert.False(t, result)
		})
	}
}

func TestAPIKeyService_IsTestKey_MultipleVariations(t *testing.T) {
	svc := NewAPIKeyService()

	testCases := []struct {
		key      string
		isTest   bool
		name     string
	}{
		{"ck_test_abc123", true, "test_key"},
		{"ck_test_", true, "test_key_short"},
		{"ck_live_abc123", false, "live_key"},
		{"ck_live_", false, "live_key_short"},
		{"CK_TEST_abc", false, "case_sensitive"},
		{"ck_testing", false, "not_test_prefix"},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			result := svc.IsTestKey(tc.key)
			assert.Equal(t, tc.isTest, result)
		})
	}
}

func TestAPIKeyService_GenerateAndValidate_Workflow(t *testing.T) {
	// Integration test: generate a key and validate it
	svc := NewAPIKeyService()

	plainKey, hash, err := svc.GenerateAPIKey(false)
	require.NoError(t, err)

	// Validate format
	err = svc.ValidateAPIKeyFormat(plainKey)
	assert.NoError(t, err)

	// Verify it's not a test key
	assert.False(t, svc.IsTestKey(plainKey))

	// Verify the hash
	assert.True(t, svc.VerifyAPIKey(plainKey, hash))
}

func TestAPIKeyService_GenerateAndValidate_TestKeyWorkflow(t *testing.T) {
	svc := NewAPIKeyService()

	plainKey, hash, err := svc.GenerateAPIKey(true)
	require.NoError(t, err)

	// Validate format
	err = svc.ValidateAPIKeyFormat(plainKey)
	assert.NoError(t, err)

	// Verify it's a test key
	assert.True(t, svc.IsTestKey(plainKey))

	// Verify the hash
	assert.True(t, svc.VerifyAPIKey(plainKey, hash))
}

func TestAPIKeyService_KeyLength(t *testing.T) {
	svc := NewAPIKeyService()

	plainKey, _, err := svc.GenerateAPIKey(false)
	require.NoError(t, err)

	// Key should be at least prefix + 32 chars
	minExpectedLength := len(APIKeyPrefix) + 32
	assert.GreaterOrEqual(t, len(plainKey), minExpectedLength)
}

func TestAPIKeyService_HashLength(t *testing.T) {
	svc := NewAPIKeyService()

	_, hash, err := svc.GenerateAPIKey(false)
	require.NoError(t, err)

	// Bcrypt hashes are typically around 60 characters
	assert.GreaterOrEqual(t, len(hash), 50)
	assert.Less(t, len(hash), 100)
}

// Helper function
func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
