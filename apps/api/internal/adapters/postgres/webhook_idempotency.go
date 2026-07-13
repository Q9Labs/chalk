package postgres

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"github.com/q9labs/chalk/apps/api/internal/webhooks"
)

type webhookIdempotencyResponse struct {
	Endpoint *webhookEndpointCache `json:"endpoint,omitempty"`
	Secret   string                `json:"secret,omitempty"`
	Delivery *webhookDeliveryCache `json:"delivery,omitempty"`
	Rotation *webhookRotationCache `json:"rotation,omitempty"`
}
type webhookEndpointCache struct {
	ID, TenantID, Name, URLRedacted string
	Enabled                         bool
	Revision, APIVersion            int
	EventTypes                      []string
	CreatedAt, UpdatedAt            time.Time
}
type webhookDeliveryCache struct {
	EventID, DeliveryID, EndpointID string
	EndpointRevision                int
	State                           string
}
type webhookRotationCache struct {
	EndpointID              string
	Revision                int
	Secret                  string
	PreviousSecretExpiresAt *time.Time
}

func idempotencyHash(value any) [32]byte { body, _ := json.Marshal(value); return sha256.Sum256(body) }

func (r WebhookRepository) replayIdempotency(ctx context.Context, tx pgx.Tx, tenantID utilities.ID, operation, key string, hash [32]byte) (webhookIdempotencyResponse, bool, error) {
	var storedHash, ciphertext []byte
	var expired bool
	err := tx.QueryRow(ctx, `select request_sha256,response_ciphertext,expires_at<=now() as expired from webhook_idempotency_records where tenant_id=$1 and operation=$2 and idempotency_key=$3`, uuid(tenantID), operation, key).Scan(&storedHash, &ciphertext, &expired)
	if errors.Is(err, pgx.ErrNoRows) {
		return webhookIdempotencyResponse{}, false, nil
	}
	if err != nil {
		return webhookIdempotencyResponse{}, false, err
	}
	if !bytes.Equal(storedHash, hash[:]) {
		return webhookIdempotencyResponse{}, false, webhooks.ErrIdempotencyKeyConflict
	}
	if expired {
		return webhookIdempotencyResponse{}, false, webhooks.ErrIdempotencyKeyExpired
	}
	if r.protector == nil {
		return webhookIdempotencyResponse{}, false, errors.New("webhook idempotency encryption unavailable")
	}
	body, err := r.protector.Unprotect(webhooks.IdempotencyScope(tenantID, operation, key), ciphertext)
	if err != nil {
		return webhookIdempotencyResponse{}, false, err
	}
	var response webhookIdempotencyResponse
	if err := json.Unmarshal(body, &response); err != nil {
		return webhookIdempotencyResponse{}, false, err
	}
	return response, true, nil
}

func (r WebhookRepository) storeIdempotency(ctx context.Context, tx pgx.Tx, tenantID utilities.ID, operation, key string, hash [32]byte, status int, resourceID utilities.ID, response webhookIdempotencyResponse) error {
	if r.protector == nil {
		return webhooks.ErrEncryptionUnavailable
	}
	body, err := json.Marshal(response)
	if err != nil {
		return err
	}
	ciphertext, err := r.protector.Protect(webhooks.IdempotencyScope(tenantID, operation, key), body)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `insert into webhook_idempotency_records(tenant_id,operation,idempotency_key,request_sha256,response_status,response_ciphertext,resource_id,expires_at) values($1,$2,$3,$4,$5,$6,$7,now()+interval '24 hours')`, uuid(tenantID), operation, key, hash[:], status, ciphertext, uuid(resourceID))
	return err
}

func cacheEndpoint(value webhooks.Endpoint) *webhookEndpointCache {
	return &webhookEndpointCache{ID: value.ID.String(), TenantID: value.TenantID.String(), Name: value.Name, URLRedacted: value.URLRedacted, Enabled: value.Enabled, Revision: value.Revision, APIVersion: value.APIVersion, EventTypes: value.EventTypes, CreatedAt: value.CreatedAt, UpdatedAt: value.UpdatedAt}
}
func (c *webhookEndpointCache) domain() webhooks.Endpoint {
	if c == nil {
		return webhooks.Endpoint{}
	}
	id, _ := utilities.ParseID(c.ID)
	tenantID, _ := utilities.ParseID(c.TenantID)
	return webhooks.Endpoint{ID: id, TenantID: tenantID, Name: c.Name, URLRedacted: c.URLRedacted, Enabled: c.Enabled, Revision: c.Revision, APIVersion: c.APIVersion, EventTypes: c.EventTypes, CreatedAt: c.CreatedAt, UpdatedAt: c.UpdatedAt}
}
func cacheDelivery(value webhooks.DeliveryResult) *webhookDeliveryCache {
	return &webhookDeliveryCache{EventID: value.EventID.String(), DeliveryID: value.DeliveryID.String(), EndpointID: value.EndpointID.String(), EndpointRevision: value.EndpointRevision, State: value.State}
}
func (c *webhookDeliveryCache) domain() webhooks.DeliveryResult {
	eventID, _ := utilities.ParseID(c.EventID)
	deliveryID, _ := utilities.ParseID(c.DeliveryID)
	endpointID, _ := utilities.ParseID(c.EndpointID)
	return webhooks.DeliveryResult{EventID: eventID, DeliveryID: deliveryID, EndpointID: endpointID, EndpointRevision: c.EndpointRevision, State: c.State}
}
