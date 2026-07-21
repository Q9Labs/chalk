package apikeys_test

import (
	"context"
	"slices"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/apikeys"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

var (
	testNow       = time.Date(2026, 7, 21, 12, 0, 0, 0, time.UTC)
	tenantID      = mustID("11111111-1111-4111-8111-111111111111")
	otherTenantID = mustID("22222222-2222-4222-8222-222222222222")
)

type repository struct {
	records        map[string]apikeys.Record
	prefixes       map[string]string
	lastUsage      apikeys.Usage
	touchErr       error
	getByPrefixErr error
	createConflict int
	rotateConflict int
}

func newRepository() *repository {
	return &repository{records: map[string]apikeys.Record{}, prefixes: map[string]string{}}
}

func (r *repository) Create(_ context.Context, input apikeys.CreateRecordInput) (apikeys.Record, error) {
	if r.createConflict > 0 {
		r.createConflict--
		return apikeys.Record{}, apikeys.ErrPrefixConflict
	}
	record := apikeys.Record{KeyHash: input.KeyHash, Key: apikeys.Key{
		ID: input.ID, TenantID: input.TenantID, Name: input.Name,
		Scopes: slices.Clone(input.Scopes), Prefix: input.KeyPrefix,
		CreatedByUserID: input.CreatedByUserID, ExpiresAt: input.ExpiresAt,
		CreatedAt: testNow, UpdatedAt: testNow,
	}}
	r.records[input.ID.String()] = record
	r.prefixes[input.KeyPrefix] = input.ID.String()
	return cloneRecord(record), nil
}

func (r *repository) Get(_ context.Context, tenantID, id utilities.ID) (apikeys.Record, error) {
	record, ok := r.records[id.String()]
	if !ok || record.TenantID != tenantID {
		return apikeys.Record{}, apikeys.ErrAPIKeyNotFound
	}
	return cloneRecord(record), nil
}

func (r *repository) GetByPrefix(_ context.Context, prefix string) (apikeys.Record, error) {
	if r.getByPrefixErr != nil {
		return apikeys.Record{}, r.getByPrefixErr
	}
	id, ok := r.prefixes[prefix]
	if !ok {
		return apikeys.Record{}, apikeys.ErrAPIKeyNotFound
	}
	return cloneRecord(r.records[id]), nil
}

func (r *repository) List(_ context.Context, tenantID utilities.ID, _ pagination.PageRequest) (apikeys.RecordList, error) {
	var records []apikeys.Record
	for _, record := range r.records {
		if record.TenantID == tenantID {
			records = append(records, cloneRecord(record))
		}
	}
	return apikeys.RecordList{Records: records, Page: pagination.Page{PageSize: len(records)}}, nil
}

func (r *repository) Rotate(_ context.Context, input apikeys.RotateRecordInput) (apikeys.Record, error) {
	if r.rotateConflict > 0 {
		r.rotateConflict--
		return apikeys.Record{}, apikeys.ErrPrefixConflict
	}
	record, ok := r.records[input.ID.String()]
	if !ok || record.TenantID != input.TenantID {
		return apikeys.Record{}, apikeys.ErrAPIKeyNotFound
	}
	delete(r.prefixes, record.Prefix)
	record.Prefix = input.KeyPrefix
	record.KeyHash = input.KeyHash
	record.ExpiresAt = input.ExpiresAt
	record.UpdatedAt = input.RotatedAt
	r.records[input.ID.String()] = record
	r.prefixes[input.KeyPrefix] = input.ID.String()
	return cloneRecord(record), nil
}

func (r *repository) Revoke(_ context.Context, tenantID, id utilities.ID, revokedAt time.Time) error {
	record, ok := r.records[id.String()]
	if !ok || record.TenantID != tenantID {
		return apikeys.ErrAPIKeyNotFound
	}
	if record.RevokedAt != nil {
		return apikeys.ErrAPIKeyRevoked
	}
	record.RevokedAt = &revokedAt
	record.UpdatedAt = revokedAt
	r.records[id.String()] = record
	return nil
}

func (r *repository) TouchLastUsed(_ context.Context, usage apikeys.Usage) error {
	r.lastUsage = usage
	return r.touchErr
}

type telemetryRecorder struct {
	authentication []apikeys.AuthenticationEvent
	usage          []apikeys.UsageTouchOutcome
}

func (r *telemetryRecorder) RecordAuthentication(_ context.Context, event apikeys.AuthenticationEvent) {
	r.authentication = append(r.authentication, event)
}

func (r *telemetryRecorder) RecordUsageTouch(_ context.Context, outcome apikeys.UsageTouchOutcome) {
	r.usage = append(r.usage, outcome)
}

func newService(repository *repository, telemetry apikeys.Telemetry) apikeys.Service {
	return apikeys.NewService(repository, apikeys.Config{
		Now: func() time.Time { return testNow }, Random: &counterReader{}, Telemetry: telemetry,
	})
}

func createKey(t testing.TB, service apikeys.Service, expiresAt time.Time) apikeys.CreateResult {
	t.Helper()
	result, err := service.Create(context.Background(), apikeys.CreateInput{
		TenantID: tenantID, Name: "Backend", Scopes: []authentication.Scope{authentication.ScopeRoomsRead}, ExpiresAt: expiresAt,
	})
	if err != nil {
		t.Fatalf("create key: %v", err)
	}
	return result
}

type counterReader struct {
	next byte
}

func (r *counterReader) Read(target []byte) (int, error) {
	for index := range target {
		target[index] = r.next
		r.next++
	}
	return len(target), nil
}

func cloneRecord(record apikeys.Record) apikeys.Record {
	record.Scopes = slices.Clone(record.Scopes)
	return record
}

func mustID(value string) utilities.ID {
	id, err := utilities.ParseID(value)
	if err != nil {
		panic(err)
	}
	return id
}
