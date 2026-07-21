package apikeys_test

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/apikeys"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
)

func TestCreateReturnsRawKeyOnceAndStoresHash(t *testing.T) {
	repository := newRepository()
	service := newService(repository, nil)

	result, err := service.Create(context.Background(), apikeys.CreateInput{
		TenantID: tenantID, Name: " Backend ",
		Scopes:    []authentication.Scope{authentication.ScopeSessionsWrite, authentication.ScopeRoomsRead},
		ExpiresAt: testNow.Add(24 * time.Hour),
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if !strings.HasPrefix(result.RawKey, "chalk_sk_") || strings.Count(result.RawKey, ".") != 1 {
		t.Fatalf("raw key = %q, want chalk_sk_<prefix>.<secret>", result.RawKey)
	}
	credentialParts := strings.Split(strings.TrimPrefix(result.RawKey, "chalk_sk_"), ".")
	prefixBytes, prefixErr := base64.RawURLEncoding.DecodeString(credentialParts[0])
	secretBytes, secretErr := base64.RawURLEncoding.DecodeString(credentialParts[1])
	if prefixErr != nil || secretErr != nil || len(prefixBytes) != 9 || len(secretBytes) != 32 {
		t.Fatalf("credential parts decode to %d prefix and %d secret bytes; want 9 and 32", len(prefixBytes), len(secretBytes))
	}
	if result.Key.Name != "Backend" {
		t.Fatalf("name = %q, want Backend", result.Key.Name)
	}
	if result.Key.Scopes[0] != authentication.ScopeRoomsRead || result.Key.Scopes[1] != authentication.ScopeSessionsWrite {
		t.Fatalf("scopes = %v, want sorted concrete scopes", result.Key.Scopes)
	}

	stored := repository.records[result.Key.ID.String()]
	digest := sha256.Sum256([]byte(result.RawKey))
	if stored.KeyHash != hex.EncodeToString(digest[:]) {
		t.Fatal("stored hash does not match SHA-256 of complete raw key")
	}
	if stored.KeyHash == result.RawKey {
		t.Fatal("repository received raw key material")
	}

	page, err := pagination.NewPageRequest(25, nil)
	if err != nil {
		t.Fatalf("page request: %v", err)
	}
	list, err := service.List(context.Background(), tenantID, page)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(list.Keys) != 1 || list.Keys[0].Prefix != result.Key.Prefix {
		t.Fatalf("listed keys = %+v, want created key metadata", list.Keys)
	}
}

func TestCreateRequiresConcreteScopesAndBoundedExpiry(t *testing.T) {
	tests := []struct {
		name   string
		scopes []authentication.Scope
		expiry time.Time
		want   error
	}{
		{name: "no scopes", expiry: testNow.Add(time.Hour), want: apikeys.ErrInvalidScopes},
		{name: "wildcard", scopes: []authentication.Scope{"*"}, expiry: testNow.Add(time.Hour), want: apikeys.ErrInvalidScopes},
		{name: "duplicate", scopes: []authentication.Scope{authentication.ScopeRoomsRead, authentication.ScopeRoomsRead}, expiry: testNow.Add(time.Hour), want: apikeys.ErrInvalidScopes},
		{name: "missing expiry", scopes: []authentication.Scope{authentication.ScopeRoomsRead}, want: apikeys.ErrInvalidExpiry},
		{name: "expired", scopes: []authentication.Scope{authentication.ScopeRoomsRead}, expiry: testNow, want: apikeys.ErrInvalidExpiry},
		{name: "over one year", scopes: []authentication.Scope{authentication.ScopeRoomsRead}, expiry: testNow.Add(apikeys.MaxTTL + time.Nanosecond), want: apikeys.ErrInvalidExpiry},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			service := newService(newRepository(), nil)
			_, err := service.Create(context.Background(), apikeys.CreateInput{
				TenantID: tenantID, Name: "Backend", Scopes: test.scopes, ExpiresAt: test.expiry,
			})
			if !errors.Is(err, test.want) {
				t.Fatalf("error = %v, want %v", err, test.want)
			}
		})
	}
}

func TestCreateAndRotateRetryPrefixCollisions(t *testing.T) {
	repository := newRepository()
	repository.createConflict = 2
	service := newService(repository, nil)

	created := createKey(t, service, testNow.Add(time.Hour))
	if repository.createConflict != 0 {
		t.Fatalf("remaining create conflicts = %d, want 0", repository.createConflict)
	}
	repository.rotateConflict = 2
	rotated, err := service.Rotate(context.Background(), tenantID, created.Key.ID, apikeys.RotateInput{})
	if err != nil {
		t.Fatalf("rotate after prefix collisions: %v", err)
	}
	if repository.rotateConflict != 0 || rotated.RawKey == created.RawKey {
		t.Fatalf("remaining rotate conflicts = %d, raw key changed = %t", repository.rotateConflict, rotated.RawKey != created.RawKey)
	}
}

func TestCreateStopsAfterBoundedPrefixCollisions(t *testing.T) {
	repository := newRepository()
	repository.createConflict = apikeys.MaxPrefixAttempts + 1
	service := newService(repository, nil)

	_, err := service.Create(context.Background(), apikeys.CreateInput{
		TenantID: tenantID, Name: "Backend", Scopes: []authentication.Scope{authentication.ScopeRoomsRead},
		ExpiresAt: testNow.Add(time.Hour),
	})
	if !errors.Is(err, apikeys.ErrPrefixConflict) {
		t.Fatalf("error = %v, want %v", err, apikeys.ErrPrefixConflict)
	}
	if repository.createConflict != 1 {
		t.Fatalf("remaining conflicts = %d, want 1 after bounded retries", repository.createConflict)
	}
}

func TestRotateInvalidatesOldKeyImmediatelyAndPreservesExpiry(t *testing.T) {
	repository := newRepository()
	service := newService(repository, nil)
	created := createKey(t, service, testNow.Add(48*time.Hour))

	rotated, err := service.Rotate(context.Background(), tenantID, created.Key.ID, apikeys.RotateInput{})
	if err != nil {
		t.Fatalf("rotate: %v", err)
	}
	if rotated.RawKey == created.RawKey {
		t.Fatal("rotation returned the previous raw key")
	}
	if !rotated.Key.ExpiresAt.Equal(created.Key.ExpiresAt) {
		t.Fatalf("expiry = %v, want preserved %v", rotated.Key.ExpiresAt, created.Key.ExpiresAt)
	}
	if _, err := service.Authenticate(context.Background(), apikeys.AuthenticateInput{RawKey: created.RawKey}); !errors.Is(err, apikeys.ErrUnauthenticated) {
		t.Fatalf("old key error = %v, want %v", err, apikeys.ErrUnauthenticated)
	}
	if _, err := service.Authenticate(context.Background(), apikeys.AuthenticateInput{RawKey: rotated.RawKey}); err != nil {
		t.Fatalf("authenticate rotated key: %v", err)
	}
}

func TestRotateCanReplaceExpiryAndRejectsInactiveKey(t *testing.T) {
	repository := newRepository()
	service := newService(repository, nil)
	created := createKey(t, service, testNow.Add(48*time.Hour))
	newExpiry := testNow.Add(72 * time.Hour)

	rotated, err := service.Rotate(context.Background(), tenantID, created.Key.ID, apikeys.RotateInput{ExpiresAt: &newExpiry})
	if err != nil {
		t.Fatalf("rotate: %v", err)
	}
	if !rotated.Key.ExpiresAt.Equal(newExpiry) {
		t.Fatalf("expiry = %v, want %v", rotated.Key.ExpiresAt, newExpiry)
	}

	revokedAt := testNow
	record := repository.records[created.Key.ID.String()]
	record.RevokedAt = &revokedAt
	repository.records[created.Key.ID.String()] = record
	if _, err := service.Rotate(context.Background(), tenantID, created.Key.ID, apikeys.RotateInput{}); !errors.Is(err, apikeys.ErrAPIKeyRevoked) {
		t.Fatalf("revoked rotate error = %v, want %v", err, apikeys.ErrAPIKeyRevoked)
	}

	record.RevokedAt = nil
	record.ExpiresAt = testNow
	repository.records[created.Key.ID.String()] = record
	if _, err := service.Rotate(context.Background(), tenantID, created.Key.ID, apikeys.RotateInput{}); !errors.Is(err, apikeys.ErrAPIKeyExpired) {
		t.Fatalf("expired rotate error = %v, want %v", err, apikeys.ErrAPIKeyExpired)
	}
}

func TestRevokeInvalidatesKeyAndCrossTenantIsNotFound(t *testing.T) {
	repository := newRepository()
	service := newService(repository, nil)
	created := createKey(t, service, testNow.Add(24*time.Hour))

	if err := service.Revoke(context.Background(), otherTenantID, created.Key.ID); !errors.Is(err, apikeys.ErrAPIKeyNotFound) {
		t.Fatalf("cross-tenant error = %v, want %v", err, apikeys.ErrAPIKeyNotFound)
	}
	if err := service.Revoke(context.Background(), tenantID, created.Key.ID); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	if _, err := service.Authenticate(context.Background(), apikeys.AuthenticateInput{RawKey: created.RawKey}); !errors.Is(err, apikeys.ErrUnauthenticated) {
		t.Fatalf("revoked authentication error = %v, want %v", err, apikeys.ErrUnauthenticated)
	}
	if err := service.Revoke(context.Background(), tenantID, created.Key.ID); err != nil {
		t.Fatalf("second revoke error = %v", err)
	}
}

func TestGetAndRotateUseTenantScopedRepositoryLookup(t *testing.T) {
	repository := newRepository()
	service := newService(repository, nil)
	created := createKey(t, service, testNow.Add(time.Hour))

	if _, err := service.Get(context.Background(), otherTenantID, created.Key.ID); !errors.Is(err, apikeys.ErrAPIKeyNotFound) {
		t.Fatalf("get error = %v, want %v", err, apikeys.ErrAPIKeyNotFound)
	}
	if _, err := service.Rotate(context.Background(), otherTenantID, created.Key.ID, apikeys.RotateInput{}); !errors.Is(err, apikeys.ErrAPIKeyNotFound) {
		t.Fatalf("rotate error = %v, want %v", err, apikeys.ErrAPIKeyNotFound)
	}
}
