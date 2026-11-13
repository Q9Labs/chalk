package apikeys

import (
	"crypto/sha256"
	"encoding/json"
	"slices"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func validName(value string) (string, error) {
	value = strings.TrimSpace(value)
	if len([]rune(value)) == 0 || len([]rune(value)) > MaxNameRunes {
		return "", ErrInvalidName
	}
	return value, nil
}

// EffectiveScopes validates stored permissions after subtracting only explicitly retired scopes.
// Creation deliberately uses validScopes instead, so retired scopes cannot be added to new keys.
func EffectiveScopes(scopes []authentication.Scope) ([]authentication.Scope, error) {
	return validScopes(slices.DeleteFunc(slices.Clone(scopes), retiredScope))
}

func retiredScope(scope authentication.Scope) bool {
	switch scope {
	case "integrations:read", "integrations:write", "integrations:delete", "users:read", "users:write", "users:delete", "audit_logs:read":
		return true
	default:
		return false
	}
}

func validScopes(scopes []authentication.Scope) ([]authentication.Scope, error) {
	if len(scopes) == 0 || len(scopes) > len(authentication.AllScopes) {
		return nil, ErrInvalidScopes
	}
	result := slices.Clone(scopes)
	slices.Sort(result)
	for index, scope := range result {
		if !authentication.ValidScope(scope) || (index > 0 && result[index-1] == scope) {
			return nil, ErrInvalidScopes
		}
	}
	return result, nil
}

func validExpiry(expiresAt, now time.Time) (time.Time, error) {
	expiresAt = expiresAt.UTC()
	now = now.UTC()
	if !expiresAt.After(now) || expiresAt.After(now.Add(MaxTTL)) {
		return time.Time{}, ErrInvalidExpiry
	}
	return expiresAt, nil
}

func validIDs(tenantID, id utilities.ID) error {
	if tenantID.IsZero() {
		return ErrInvalidTenantID
	}
	if id.IsZero() {
		return ErrInvalidAPIKeyID
	}
	return nil
}

func validRequestKey(value string) error {
	if value == "" || apiKeyRequestKeyPattern.MatchString(value) {
		return nil
	}
	return ErrInvalidRequestKey
}

func createFingerprint(name string, scopes []authentication.Scope, expiresAt time.Time) ([32]byte, error) {
	value, err := json.Marshal(struct {
		Name      string                 `json:"name"`
		Scopes    []authentication.Scope `json:"scopes"`
		ExpiresAt time.Time              `json:"expires_at"`
	}{Name: name, Scopes: scopes, ExpiresAt: expiresAt.UTC()})
	if err != nil {
		return [32]byte{}, err
	}
	return sha256.Sum256(value), nil
}

func rotateFingerprint(id utilities.ID, expiresAt time.Time) ([32]byte, error) {
	value, err := json.Marshal(struct {
		APIKeyID  string    `json:"api_key_id"`
		ExpiresAt time.Time `json:"expires_at"`
	}{APIKeyID: id.String(), ExpiresAt: expiresAt.UTC()})
	if err != nil {
		return [32]byte{}, err
	}
	return sha256.Sum256(value), nil
}
