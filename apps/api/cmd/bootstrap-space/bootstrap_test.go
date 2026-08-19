package main

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/apikeys"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

var (
	bootstrapTestNow      = time.Date(2026, 7, 22, 12, 0, 0, 0, time.UTC)
	bootstrapTestOwnerID  = bootstrapTestID("11111111-1111-4111-8111-111111111111")
	bootstrapTestTenantID = bootstrapTestID("22222222-2222-4222-8222-222222222222")
	bootstrapTestKeyID    = bootstrapTestID("33333333-3333-4333-8333-333333333333")
	bootstrapTestSpaceID  = bootstrapTestID("44444444-4444-4444-8444-444444444444")
)

type fakeBootstrapTransaction struct {
	ownerExists        bool
	tenant             tenants.Tenant
	tenantFound        bool
	key                apikeys.Key
	keyFound           bool
	space              spaces.Space
	spaceFound         bool
	locked             bool
	ownerSet           bool
	createdTenantInput tenants.CreateTenantInput
	createdKeyInput    apikeys.CreateInput
	createdSpaceInput  spaces.CreateSpaceInput
	committed          bool
	commitErr          error
	rolledBack         bool
}

func (t *fakeBootstrapTransaction) Lock(context.Context, string) error {
	t.locked = true
	return nil
}

func (t *fakeBootstrapTransaction) UserExists(context.Context, utilities.ID) (bool, error) {
	return t.ownerExists, nil
}

func (t *fakeBootstrapTransaction) TenantByName(context.Context, string) (tenants.Tenant, bool, error) {
	return t.tenant, t.tenantFound, nil
}

func (t *fakeBootstrapTransaction) CreateTenant(_ context.Context, input tenants.CreateTenantInput) (tenants.Tenant, error) {
	t.createdTenantInput = input
	input.ID = bootstrapTestTenantID
	return tenants.Tenant{ID: input.ID, Name: input.Name, DefaultMediaPlane: input.DefaultMediaPlane, MediaPlaneProviderConfig: input.MediaPlaneProviderConfig}, nil
}

func (t *fakeBootstrapTransaction) EnsureOwner(context.Context, utilities.ID, utilities.ID) error {
	t.ownerSet = true
	return nil
}

func (t *fakeBootstrapTransaction) ActiveAPIKeyByName(context.Context, utilities.ID, string, time.Time) (apikeys.Key, bool, error) {
	return t.key, t.keyFound, nil
}

func (t *fakeBootstrapTransaction) CreateAPIKey(_ context.Context, input apikeys.CreateInput, _ time.Time) (apikeys.CreateResult, error) {
	t.createdKeyInput = input
	return apikeys.CreateResult{Key: apikeys.Key{ID: bootstrapTestKeyID, TenantID: input.TenantID, Name: input.Name, Scopes: input.Scopes}, RawKey: "chalk_sk_test.once"}, nil
}

func (t *fakeBootstrapTransaction) SpaceBySlug(context.Context, utilities.ID, string) (spaces.Space, bool, error) {
	return t.space, t.spaceFound, nil
}

func (t *fakeBootstrapTransaction) CreateSpace(_ context.Context, input spaces.CreateSpaceInput) (spaces.Space, error) {
	t.createdSpaceInput = input
	input.ID = bootstrapTestSpaceID
	return spaces.Space{ID: input.ID, TenantID: input.TenantID, Name: input.Name, Slug: input.Slug, MediaPlane: input.MediaPlane}, nil
}

func (t *fakeBootstrapTransaction) Commit(context.Context) error {
	t.committed = true
	return t.commitErr
}

func (t *fakeBootstrapTransaction) Rollback(context.Context) error {
	t.rolledBack = true
	return nil
}

func TestBootstrapSpaceCreatesLeastPrivilegeResources(t *testing.T) {
	transaction := &fakeBootstrapTransaction{ownerExists: true}
	result, err := bootstrapSpace(context.Background(), transaction, bootstrapTestInput())
	if err != nil {
		t.Fatalf("bootstrap space: %v", err)
	}
	if !transaction.locked || !transaction.ownerSet {
		t.Fatal("bootstrap did not acquire its lock and owner boundary")
	}
	if transaction.createdTenantInput.DefaultMediaPlane == nil || *transaction.createdTenantInput.DefaultMediaPlane != cloudflareSFU {
		t.Fatalf("default media plane = %v", transaction.createdTenantInput.DefaultMediaPlane)
	}
	if string(transaction.createdTenantInput.MediaPlaneProviderConfig) != providerConfigValue {
		t.Fatalf("provider config = %s", transaction.createdTenantInput.MediaPlaneProviderConfig)
	}
	if len(transaction.createdKeyInput.Scopes) != 2 || transaction.createdKeyInput.Scopes[0] != authentication.ScopeEpisodesWrite || transaction.createdKeyInput.Scopes[1] != authentication.ScopeSpacesWrite {
		t.Fatalf("broker scopes = %v", transaction.createdKeyInput.Scopes)
	}
	if transaction.createdKeyInput.CreatedByUserID != bootstrapTestOwnerID || !transaction.createdKeyInput.ExpiresAt.Equal(bootstrapTestNow.Add(defaultAPIKeyTTL)) {
		t.Fatalf("broker key owner/expiry = %s / %s", transaction.createdKeyInput.CreatedByUserID, transaction.createdKeyInput.ExpiresAt)
	}
	if transaction.createdSpaceInput.MediaPlane != cloudflareSFU || transaction.createdSpaceInput.CreatedByUserID != bootstrapTestOwnerID {
		t.Fatalf("space input = %+v", transaction.createdSpaceInput)
	}
	if result.TenantID != bootstrapTestTenantID.String() || result.SpaceID != bootstrapTestSpaceID.String() || result.APIKeyID != bootstrapTestKeyID.String() || !result.APIKeyCreated {
		t.Fatalf("result = %+v", result)
	}
	if result.APIKeySecret == nil || *result.APIKeySecret != "chalk_sk_test.once" {
		t.Fatalf("api key secret = %v", result.APIKeySecret)
	}
}

func TestBootstrapSpaceReusesCompatibleResourcesWithoutReturningSecret(t *testing.T) {
	defaultMediaPlane := cloudflareSFU
	transaction := &fakeBootstrapTransaction{
		ownerExists: true,
		tenantFound: true,
		tenant:      tenants.Tenant{ID: bootstrapTestTenantID, Name: defaultTenantName, DefaultMediaPlane: &defaultMediaPlane, MediaPlaneProviderConfig: json.RawMessage(providerConfigValue)},
		keyFound:    true,
		key:         apikeys.Key{ID: bootstrapTestKeyID, TenantID: bootstrapTestTenantID, Scopes: []authentication.Scope{authentication.ScopeEpisodesWrite, authentication.ScopeSpacesWrite}},
		spaceFound:  true,
		space:       spaces.Space{ID: bootstrapTestSpaceID, TenantID: bootstrapTestTenantID, Name: defaultSpaceName, Slug: defaultSpaceSlug, MediaPlane: cloudflareSFU},
	}
	result, err := bootstrapSpace(context.Background(), transaction, bootstrapTestInput())
	if err != nil {
		t.Fatalf("bootstrap space: %v", err)
	}
	if !transaction.createdTenantInput.ID.IsZero() || !transaction.createdKeyInput.TenantID.IsZero() || !transaction.createdSpaceInput.TenantID.IsZero() {
		t.Fatal("compatible resources were recreated")
	}
	if result.APIKeyCreated || result.APIKeySecret != nil {
		t.Fatalf("reused key returned one-time material: %+v", result)
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		t.Fatalf("marshal result: %v", err)
	}
	if string(encoded) == "" || jsonContainsField(t, encoded, "api_key_secret") {
		t.Fatalf("reused result contains secret field: %s", encoded)
	}
}

func TestBootstrapSpaceRejectsMissingOwnerAndIncompatibleKey(t *testing.T) {
	_, err := bootstrapSpace(context.Background(), &fakeBootstrapTransaction{}, bootstrapTestInput())
	if err == nil || err.Error() != "owner user does not exist" {
		t.Fatalf("missing owner error = %v", err)
	}

	defaultMediaPlane := cloudflareSFU
	for _, test := range []struct {
		name   string
		scopes []authentication.Scope
	}{
		{name: "episodes-only", scopes: []authentication.Scope{authentication.ScopeEpisodesWrite}},
		{name: "broader", scopes: []authentication.Scope{authentication.ScopeEpisodesWrite, authentication.ScopeSpacesWrite, authentication.ScopeEpisodesRead}},
		{name: "different", scopes: []authentication.Scope{authentication.ScopeSpacesWrite}},
	} {
		t.Run(test.name, func(t *testing.T) {
			transaction := &fakeBootstrapTransaction{
				ownerExists: true,
				tenantFound: true,
				tenant:      tenants.Tenant{ID: bootstrapTestTenantID, DefaultMediaPlane: &defaultMediaPlane, MediaPlaneProviderConfig: json.RawMessage(providerConfigValue)},
				keyFound:    true,
				key:         apikeys.Key{ID: bootstrapTestKeyID, Scopes: test.scopes},
			}
			_, err := bootstrapSpace(context.Background(), transaction, bootstrapTestInput())
			if err == nil || err.Error() != "active broker api key has broader or incompatible scopes" {
				t.Fatalf("incompatible key error = %v", err)
			}
		})
	}
}

func bootstrapTestInput() bootstrapInput {
	return bootstrapInput{
		TenantName: defaultTenantName, SpaceName: defaultSpaceName, SpaceSlug: defaultSpaceSlug,
		APIKeyName: defaultAPIKeyName, APIKeyTTL: defaultAPIKeyTTL, OwnerUserID: bootstrapTestOwnerID, Now: bootstrapTestNow,
	}
}

func bootstrapTestID(value string) utilities.ID {
	id, err := utilities.ParseID(value)
	if err != nil {
		panic(err)
	}
	return id
}

func jsonContainsField(t *testing.T, encoded []byte, field string) bool {
	t.Helper()
	var value map[string]any
	if err := json.Unmarshal(encoded, &value); err != nil {
		t.Fatalf("unmarshal result: %v", err)
	}
	_, ok := value[field]
	return ok
}
