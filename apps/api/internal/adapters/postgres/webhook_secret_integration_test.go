package postgres

import (
	"context"
	"encoding/base64"
	"errors"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/webhooks"
)

func TestWebhookSecretRotationOverlapImmediateRevocationAndMutationFencing(t *testing.T) {
	pool := webhookIntegrationPool(t)
	ctx := context.Background()
	tenantID := webhookIntegrationID(t)
	if _, err := pool.Exec(ctx, `insert into tenants(id,name) values($1,'Webhook mutation fence test')`, uuid(tenantID)); err != nil {
		t.Fatal(err)
	}
	cleanupWebhookTenant(t, pool, tenantID)
	protector, _ := webhooks.NewAESGCMProtector(make([]byte, 32))
	repository := NewWebhookRepository(pool, protector)
	created, err := repository.Create(ctx, webhooks.CreateInput{TenantID: tenantID, Name: "Rotate", URL: "https://example.com/old", Enabled: true, APIVersion: 1, EventTypes: []string{"space.created"}, IdempotencyKey: "create-rotation-0001"})
	if err != nil {
		t.Fatal(err)
	}
	rotated, err := repository.RotateSecret(ctx, tenantID, created.Endpoint.ID, false, "rotate-overlap-0001")
	if err != nil || rotated.PreviousSecretExpiresAt == nil || rotated.Revision != 1 {
		t.Fatalf("overlap rotation=%#v error=%v", rotated, err)
	}
	var currentCiphertext, previousCiphertext []byte
	var previousSet bool
	if err := pool.QueryRow(ctx, `select current_secret_ciphertext,previous_secret_ciphertext,previous_secret_expires_at is not null from webhook_endpoints where tenant_id=$1 and id=$2`, uuid(tenantID), uuid(created.Endpoint.ID)).Scan(&currentCiphertext, &previousCiphertext, &previousSet); err != nil {
		t.Fatal(err)
	}
	oldRaw, _ := base64.StdEncoding.DecodeString(strings.TrimPrefix(created.Secret, "whsec_"))
	newRaw, _ := base64.StdEncoding.DecodeString(strings.TrimPrefix(rotated.Secret, "whsec_"))
	oldPlaintext, oldErr := protector.Unprotect(webhooks.SecretScope(tenantID, created.Endpoint.ID), previousCiphertext)
	newPlaintext, newErr := protector.Unprotect(webhooks.SecretScope(tenantID, created.Endpoint.ID), currentCiphertext)
	if !previousSet || oldErr != nil || newErr != nil || !slices.Equal(oldPlaintext, oldRaw) || !slices.Equal(newPlaintext, newRaw) {
		t.Fatal("rotation overlap did not retain old and current signing material")
	}
	delivery, err := repository.Test(ctx, tenantID, created.Endpoint.ID, "test-rotate-fence-01", webhooks.EventMetadata{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `update webhook_deliveries set next_attempt_at='1800-01-01T00:00:00Z' where tenant_id=$1 and id=$2`, uuid(tenantID), uuid(delivery.DeliveryID)); err != nil {
		t.Fatal(err)
	}
	dispatch := NewWebhookDispatchRepository(pool)
	claims, err := dispatch.Claim(ctx, "rotation-worker-old", 1, time.Minute)
	if err != nil || len(claims) != 1 || claims[0].DeliveryID != delivery.DeliveryID {
		t.Fatalf("pre-rotation claim=%#v error=%v", claims, err)
	}
	oldClaim := claims[0]
	immediate, err := repository.RotateSecret(ctx, tenantID, created.Endpoint.ID, true, "rotate-immediate-001")
	if err != nil || immediate.Revision != 1 {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `select previous_secret_ciphertext is not null or previous_secret_expires_at is not null from webhook_endpoints where tenant_id=$1 and id=$2`, uuid(tenantID), uuid(created.Endpoint.ID)).Scan(&previousSet); err != nil {
		t.Fatal(err)
	}
	if previousSet {
		t.Fatal("immediate rotation retained previous signing material")
	}
	if err := dispatch.Complete(ctx, oldClaim, webhooks.AttemptResult{Success: true, HTTPStatus: 204, FinishedAt: time.Now().UTC()}); !errors.Is(err, webhooks.ErrDeliveryLeaseLost) {
		t.Fatalf("old signing claim completion error=%v, want lease lost", err)
	}
	if _, err := pool.Exec(ctx, `update webhook_deliveries set next_attempt_at='1800-01-01T00:00:00Z' where tenant_id=$1 and id=$2`, uuid(tenantID), uuid(delivery.DeliveryID)); err != nil {
		t.Fatal(err)
	}
	claims, err = dispatch.Claim(ctx, "rotation-worker-new", 1, time.Minute)
	if err != nil || len(claims) != 1 || claims[0].DeliveryID != delivery.DeliveryID || claims[0].AttemptNumber != 2 {
		t.Fatalf("post-rotation claim=%#v error=%v", claims, err)
	}
	if len(claims[0].PreviousSecretCiphertext) != 0 {
		t.Fatal("post-rotation retry retained previous signing material")
	}
	immediateRaw, _ := base64.StdEncoding.DecodeString(strings.TrimPrefix(immediate.Secret, "whsec_"))
	immediatePlaintext, err := protector.Unprotect(webhooks.SecretScope(tenantID, created.Endpoint.ID), claims[0].CurrentSecretCiphertext)
	if err != nil || !slices.Equal(immediatePlaintext, immediateRaw) {
		t.Fatal("post-rotation retry did not load the new signing secret")
	}
	if err := dispatch.Complete(ctx, claims[0], webhooks.AttemptResult{Success: true, HTTPStatus: 204, FinishedAt: time.Now().UTC()}); err != nil {
		t.Fatal(err)
	}

	delivery, err = repository.Test(ctx, tenantID, created.Endpoint.ID, "test-disable-000001", webhooks.EventMetadata{})
	if err != nil {
		t.Fatal(err)
	}
	enabled := false
	if _, err := repository.Patch(ctx, tenantID, created.Endpoint.ID, webhooks.PatchInput{Enabled: &enabled, ExpectedRevision: immediate.Revision, IdempotencyKey: "disable-fence-0001"}, "", ""); err != nil {
		t.Fatal(err)
	}
	var deliveryState string
	if err := pool.QueryRow(ctx, `select state from webhook_deliveries where tenant_id=$1 and id=$2`, uuid(tenantID), uuid(delivery.DeliveryID)).Scan(&deliveryState); err != nil {
		t.Fatal(err)
	}
	if deliveryState != "canceled" {
		t.Fatalf("disabled delivery state=%q, want canceled", deliveryState)
	}
}
