package webhooks

import (
	"context"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type repositoryStub struct {
	patchInput     PatchInput
	patchURL       string
	patchRedacted  string
	listFilters    DeliveryFilters
	patchCallCount int
	listCallCount  int
	auditFailures  []FailureAuditInput
}

func (r *repositoryStub) RecordWebhookFailure(_ context.Context, input FailureAuditInput) error {
	r.auditFailures = append(r.auditFailures, input)
	return nil
}

func (r *repositoryStub) Create(context.Context, CreateInput) (CreateResult, error) {
	return CreateResult{}, nil
}
func (r *repositoryStub) Get(context.Context, utilities.ID, utilities.ID) (Endpoint, error) {
	return Endpoint{}, nil
}
func (r *repositoryStub) List(context.Context, utilities.ID, pagination.PageRequest) (EndpointList, error) {
	return EndpointList{}, nil
}
func (r *repositoryStub) Patch(_ context.Context, _, _ utilities.ID, input PatchInput, normalizedURL, redactedURL string) (Endpoint, error) {
	r.patchCallCount++
	r.patchInput = input
	r.patchURL = normalizedURL
	r.patchRedacted = redactedURL
	return Endpoint{}, nil
}
func (r *repositoryStub) Delete(context.Context, utilities.ID, utilities.ID, int, string) error {
	return nil
}
func (r *repositoryStub) RotateSecret(context.Context, utilities.ID, utilities.ID, bool, string) (RotateResult, error) {
	return RotateResult{}, nil
}
func (r *repositoryStub) Test(context.Context, utilities.ID, utilities.ID, string, EventMetadata) (DeliveryResult, error) {
	return DeliveryResult{}, nil
}
func (r *repositoryStub) ListDeliveries(_ context.Context, _, _ utilities.ID, filters DeliveryFilters, _ pagination.PageRequest) (DeliveryList, error) {
	r.listCallCount++
	r.listFilters = filters
	return DeliveryList{}, nil
}
func (r *repositoryStub) GetDelivery(context.Context, utilities.ID, utilities.ID, utilities.ID) (DeliveryDetail, error) {
	return DeliveryDetail{}, nil
}
func (r *repositoryStub) Redeliver(context.Context, utilities.ID, utilities.ID, utilities.ID, string) (DeliveryResult, error) {
	return DeliveryResult{}, nil
}

func TestServicePatchNormalizesInputsBeforeRepository(t *testing.T) {
	t.Parallel()

	repository := &repositoryStub{}
	service := NewService(repository, nil)
	name := "  Production events  "
	targetURL := "https://Hooks.Example.com/chalk?token=secret"
	eventTypes := []string{"room.updated", "room.created", "room.updated"}
	_, err := service.Patch(context.Background(), webhookTestID(t, "10000000-0000-4000-8000-000000000001"), webhookTestID(t, "20000000-0000-4000-8000-000000000001"), PatchInput{
		Name:             &name,
		URL:              &targetURL,
		EventTypes:       &eventTypes,
		ExpectedRevision: 2,
		IdempotencyKey:   "patch-request-0001",
	})
	if err != nil {
		t.Fatal(err)
	}
	if repository.patchCallCount != 1 {
		t.Fatalf("patch calls = %d, want 1", repository.patchCallCount)
	}
	if got := *repository.patchInput.Name; got != "Production events" {
		t.Fatalf("name = %q", got)
	}
	if got := *repository.patchInput.EventTypes; len(got) != 2 || got[0] != "room.created" || got[1] != "room.updated" {
		t.Fatalf("event types = %#v", got)
	}
	if repository.patchURL != "https://hooks.example.com/chalk?token=secret" {
		t.Fatalf("normalized URL = %q", repository.patchURL)
	}
	if repository.patchRedacted != "https://hooks.example.com/chalk?REDACTED" {
		t.Fatalf("redacted URL = %q", repository.patchRedacted)
	}
}

func TestServiceRejectsInvalidDeliveryFiltersBeforeRepository(t *testing.T) {
	t.Parallel()

	repository := &repositoryStub{}
	service := NewService(repository, nil)
	tenantID := webhookTestID(t, "10000000-0000-4000-8000-000000000001")
	endpointID := webhookTestID(t, "20000000-0000-4000-8000-000000000001")
	for _, filters := range []DeliveryFilters{{States: []string{"unknown"}}, {EventTypes: []string{"tenant.deleted"}}} {
		if _, err := service.ListDeliveries(context.Background(), tenantID, endpointID, filters, pagination.PageRequest{}); err != ErrInvalidDeliveryFilter {
			t.Fatalf("filters %#v error = %v, want %v", filters, err, ErrInvalidDeliveryFilter)
		}
	}
	if repository.listCallCount != 0 {
		t.Fatalf("list calls = %d, want 0", repository.listCallCount)
	}

	filters := DeliveryFilters{States: []string{"retry_wait", "erased"}, EventTypes: []string{"endpoint.test", "recording.completed"}}
	if _, err := service.ListDeliveries(context.Background(), tenantID, endpointID, filters, pagination.PageRequest{}); err != nil {
		t.Fatal(err)
	}
	if repository.listCallCount != 1 {
		t.Fatalf("list calls = %d, want 1", repository.listCallCount)
	}
}

func TestServiceAuditsMutationRevisionAndIdempotencyFailures(t *testing.T) {
	repository := &repositoryStub{}
	service := NewService(repository, nil)
	tenantID := webhookTestID(t, "10000000-0000-4000-8000-000000000001")
	endpointID := webhookTestID(t, "20000000-0000-4000-8000-000000000001")
	name := "Renamed"
	if _, err := service.Patch(context.Background(), tenantID, endpointID, PatchInput{Name: &name, ExpectedRevision: 0, IdempotencyKey: "patch-request-0001"}); err != ErrRevisionConflict {
		t.Fatalf("patch error = %v", err)
	}
	if err := service.Delete(context.Background(), tenantID, endpointID, 1, "short"); err != ErrIdempotencyKeyRequired {
		t.Fatalf("delete error = %v", err)
	}
	enabled := false
	if _, err := service.Patch(context.Background(), tenantID, endpointID, PatchInput{Enabled: &enabled, ExpectedRevision: 0, IdempotencyKey: "disable-request-0001"}); err != ErrRevisionConflict {
		t.Fatalf("disable error = %v", err)
	}
	if len(repository.auditFailures) != 3 {
		t.Fatalf("failure audits = %#v", repository.auditFailures)
	}
	if repository.auditFailures[0].ErrorCode != "revision_conflict" || repository.auditFailures[1].ErrorCode != "idempotency_key_required" || repository.auditFailures[2].Action != "webhook_endpoint.disable" || repository.auditFailures[2].ErrorCode != "revision_conflict" {
		t.Fatalf("failure audit codes = %#v", repository.auditFailures)
	}
}

func webhookTestID(t *testing.T, value string) utilities.ID {
	t.Helper()
	result, err := utilities.ParseID(value)
	if err != nil {
		t.Fatal(err)
	}
	return result
}
