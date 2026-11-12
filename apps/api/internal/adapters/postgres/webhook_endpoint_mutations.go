package postgres

import (
	"context"
	"errors"
	"fmt"
	"slices"

	"github.com/jackc/pgx/v5"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"github.com/q9labs/chalk/apps/api/internal/webhooks"
)

func (r WebhookRepository) Patch(ctx context.Context, tenantID, endpointID utilities.ID, input webhooks.PatchInput, normalizedURL, redactedURL string) (webhooks.Endpoint, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return webhooks.Endpoint{}, err
	}
	defer tx.Rollback(ctx)
	queries := sqlc.New(tx)
	if err := lockWebhookTenant(ctx, queries, tenantID); err != nil {
		return webhooks.Endpoint{}, err
	}
	hashInput := input
	hashInput.IdempotencyKey = ""
	hash := idempotencyHash(struct {
		Endpoint string
		Patch    webhooks.PatchInput
	}{endpointID.String(), hashInput})
	if cached, ok, err := r.replayIdempotency(ctx, tx, tenantID, "endpoint.patch", input.IdempotencyKey, hash); err != nil {
		return webhooks.Endpoint{}, err
	} else if ok {
		return cached.Endpoint.domain(), nil
	}
	current, err := queries.GetWebhookEndpoint(ctx, sqlc.GetWebhookEndpointParams{TenantID: uuid(tenantID), EndpointID: uuid(endpointID)})
	if errors.Is(err, pgx.ErrNoRows) {
		return webhooks.Endpoint{}, webhooks.ErrEndpointNotFound
	}
	if err != nil {
		return webhooks.Endpoint{}, err
	}
	if int(current.Revision) != input.ExpectedRevision {
		return webhooks.Endpoint{}, webhooks.ErrRevisionConflict
	}
	name, enabled := current.Name, current.Enabled
	if input.Name != nil {
		name = *input.Name
	}
	if input.Enabled != nil {
		enabled = *input.Enabled
	}
	urlChanged := false
	if input.URL != nil {
		if r.protector == nil {
			return webhooks.Endpoint{}, webhooks.ErrEncryptionUnavailable
		}
		plaintextURL, decryptErr := r.protector.Unprotect(webhooks.URLScope(tenantID, endpointID, id(current.TargetRevisionID)), current.UrlCiphertext)
		if decryptErr != nil {
			return webhooks.Endpoint{}, decryptErr
		}
		urlChanged = string(plaintextURL) != normalizedURL
	}
	apiVersionChanged := input.APIVersion != nil && int(current.ApiVersion) != *input.APIVersion
	eventTypesChanged := input.EventTypes != nil && !slices.Equal(current.EventTypes, *input.EventTypes)
	targetChanged := urlChanged || apiVersionChanged || eventTypesChanged
	targetRevision := current.CurrentTargetRevision
	var canceledCount int64
	if targetChanged {
		if r.protector == nil {
			return webhooks.Endpoint{}, webhooks.ErrEncryptionUnavailable
		}
		targetRevision++
		revisionID, idErr := utilities.NewID()
		if idErr != nil {
			return webhooks.Endpoint{}, idErr
		}
		var encryptedURL []byte
		if input.URL == nil {
			plaintextURL, decryptErr := r.protector.Unprotect(webhooks.URLScope(tenantID, endpointID, id(current.TargetRevisionID)), current.UrlCiphertext)
			if decryptErr != nil {
				return webhooks.Endpoint{}, decryptErr
			}
			encryptedURL, err = r.protector.Protect(webhooks.URLScope(tenantID, endpointID, revisionID), plaintextURL)
			redactedURL = current.UrlRedacted
		} else {
			encryptedURL, err = r.protector.Protect(webhooks.URLScope(tenantID, endpointID, revisionID), []byte(normalizedURL))
		}
		if err != nil {
			return webhooks.Endpoint{}, err
		}
		apiVersion := current.ApiVersion
		if input.APIVersion != nil {
			apiVersion = int32(*input.APIVersion)
		}
		eventTypes := current.EventTypes
		if input.EventTypes != nil {
			eventTypes = *input.EventTypes
		}
		_, err = queries.InsertWebhookEndpointRevision(ctx, sqlc.InsertWebhookEndpointRevisionParams{ID: uuid(revisionID), TenantID: uuid(tenantID), EndpointID: uuid(endpointID), Revision: targetRevision, UrlCiphertext: encryptedURL, UrlRedacted: redactedURL, ApiVersion: apiVersion, EventTypes: eventTypes})
		if err != nil {
			return webhooks.Endpoint{}, err
		}
	}
	_, err = queries.UpdateWebhookEndpoint(ctx, sqlc.UpdateWebhookEndpointParams{Name: name, Enabled: enabled, CurrentTargetRevision: targetRevision, TenantID: uuid(tenantID), EndpointID: uuid(endpointID), ExpectedRevision: int32(input.ExpectedRevision)})
	if errors.Is(err, pgx.ErrNoRows) {
		return webhooks.Endpoint{}, webhooks.ErrRevisionConflict
	}
	if err != nil {
		return webhooks.Endpoint{}, err
	}
	if targetChanged {
		err = cancelWebhookDeliveries(ctx, tx, tenantID, endpointID, &targetRevision, "target_replaced", &canceledCount)
		if err == nil {
			_, err = queries.DestroyOldWebhookTargetURLs(ctx, sqlc.DestroyOldWebhookTargetURLsParams{TenantID: uuid(tenantID), EndpointID: uuid(endpointID), CurrentTargetRevision: targetRevision})
		}
	}
	if !enabled {
		err = cancelWebhookDeliveries(ctx, tx, tenantID, endpointID, nil, "endpoint_disabled", &canceledCount)
	}
	if err != nil {
		return webhooks.Endpoint{}, err
	}
	finalRow, err := queries.GetWebhookEndpoint(ctx, sqlc.GetWebhookEndpointParams{TenantID: uuid(tenantID), EndpointID: uuid(endpointID)})
	if err != nil {
		return webhooks.Endpoint{}, err
	}
	result := mapGetWebhookEndpoint(finalRow)

	if err := r.storeIdempotency(ctx, tx, tenantID, "endpoint.patch", input.IdempotencyKey, hash, 200, endpointID, webhookIdempotencyResponse{Endpoint: cacheEndpoint(result)}); err != nil {
		return webhooks.Endpoint{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return webhooks.Endpoint{}, err
	}
	webhooks.RecordTerminalDeliveries(ctx, "canceled", canceledCount)
	return result, nil
}

func (r WebhookRepository) Delete(ctx context.Context, tenantID, endpointID utilities.ID, revision int, key string) error {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	count, err := r.deleteWebhookEndpointTx(ctx, tx, tenantID, endpointID, revision, key)
	if err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	webhooks.RecordTerminalDeliveries(ctx, "canceled", count)
	return nil
}

func (r WebhookRepository) deleteWebhookEndpointTx(ctx context.Context, tx pgx.Tx, tenantID, endpointID utilities.ID, revision int, key string) (int64, error) {
	queries := sqlc.New(tx)
	if err := lockWebhookTenant(ctx, queries, tenantID); err != nil {
		return 0, err
	}
	hash := idempotencyHash(struct {
		Endpoint string
		Revision int
	}{endpointID.String(), revision})
	if _, ok, err := r.replayIdempotency(ctx, tx, tenantID, "endpoint.delete", key, hash); err != nil {
		return 0, err
	} else if ok {
		return 0, nil
	}
	canceledCount, err := eraseWebhookEndpointTx(ctx, tx, tenantID, endpointID, revision)
	if err != nil {
		return 0, err
	}
	if err := r.storeIdempotency(ctx, tx, tenantID, "endpoint.delete", key, hash, 204, endpointID, webhookIdempotencyResponse{}); err != nil {
		return 0, err
	}
	return canceledCount, nil
}

func eraseWebhookEndpointTx(ctx context.Context, tx pgx.Tx, tenantID, endpointID utilities.ID, revision int) (int64, error) {
	queries := sqlc.New(tx)
	var currentRevision int32
	var deleted bool
	err := tx.QueryRow(ctx, `select revision,deleted_at is not null from webhook_endpoints where tenant_id=$1 and id=$2 for update`, uuid(tenantID), uuid(endpointID)).Scan(&currentRevision, &deleted)
	if errors.Is(err, pgx.ErrNoRows) || deleted {
		return 0, webhooks.ErrEndpointNotFound
	}
	if err != nil {
		return 0, err
	}
	if currentRevision != int32(revision) {
		return 0, webhooks.ErrRevisionConflict
	}
	_, err = queries.DeleteWebhookEndpoint(ctx, sqlc.DeleteWebhookEndpointParams{TenantID: uuid(tenantID), EndpointID: uuid(endpointID), ExpectedRevision: int32(revision)})
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, fmt.Errorf("delete webhook endpoint after locked revision check: %w", err)
	}
	if err != nil {
		return 0, err
	}
	var canceledCount int64
	err = cancelWebhookDeliveries(ctx, tx, tenantID, endpointID, nil, "endpoint_deleted", &canceledCount)
	if err == nil {
		_, err = queries.DestroyWebhookEndpointURLs(ctx, sqlc.DestroyWebhookEndpointURLsParams{TenantID: uuid(tenantID), EndpointID: uuid(endpointID)})
	}
	if err != nil {
		return 0, err
	}

	return canceledCount, nil
}

func (r WebhookRepository) RotateSecret(ctx context.Context, tenantID, endpointID utilities.ID, immediate bool, key string) (webhooks.RotateResult, error) {
	if r.protector == nil {
		return webhooks.RotateResult{}, webhooks.ErrEncryptionUnavailable
	}
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return webhooks.RotateResult{}, err
	}
	defer tx.Rollback(ctx)
	queries := sqlc.New(tx)
	if err := lockWebhookTenant(ctx, queries, tenantID); err != nil {
		return webhooks.RotateResult{}, err
	}
	hash := idempotencyHash(struct {
		Endpoint  string
		Immediate bool
	}{endpointID.String(), immediate})
	if cached, ok, err := r.replayIdempotency(ctx, tx, tenantID, "endpoint.rotate_secret", key, hash); err != nil {
		return webhooks.RotateResult{}, err
	} else if ok {
		c := cached.Rotation
		id, _ := utilities.ParseID(c.EndpointID)
		return webhooks.RotateResult{EndpointID: id, Revision: c.Revision, Secret: c.Secret, PreviousSecretExpiresAt: c.PreviousSecretExpiresAt}, nil
	}
	secret, rawSecret, err := webhooks.NewSigningSecret()
	if err != nil {
		return webhooks.RotateResult{}, err
	}
	ciphertext, err := r.protector.Protect(webhooks.SecretScope(tenantID, endpointID), rawSecret)
	if err != nil {
		return webhooks.RotateResult{}, err
	}
	row, err := queries.RotateWebhookEndpointSecret(ctx, sqlc.RotateWebhookEndpointSecretParams{RevokePrevious: immediate, CurrentSecretCiphertext: ciphertext, TenantID: uuid(tenantID), EndpointID: uuid(endpointID)})
	if errors.Is(err, pgx.ErrNoRows) {
		return webhooks.RotateResult{}, webhooks.ErrEndpointNotFound
	}
	if err != nil {
		return webhooks.RotateResult{}, err
	}
	if immediate {
		if err := fenceWebhookDeliveriesForSecretRotation(ctx, tx, tenantID, endpointID); err != nil {
			return webhooks.RotateResult{}, err
		}
	}
	result := webhooks.RotateResult{EndpointID: id(row.ID), Revision: int(row.Revision), Secret: secret, PreviousSecretExpiresAt: nullableTimestamp(row.PreviousSecretExpiresAt)}

	if err := r.storeIdempotency(ctx, tx, tenantID, "endpoint.rotate_secret", key, hash, 200, endpointID, webhookIdempotencyResponse{Rotation: &webhookRotationCache{EndpointID: result.EndpointID.String(), Revision: result.Revision, Secret: result.Secret, PreviousSecretExpiresAt: result.PreviousSecretExpiresAt}}); err != nil {
		return webhooks.RotateResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return webhooks.RotateResult{}, err
	}
	return result, nil
}

func lockWebhookTenant(ctx context.Context, queries *sqlc.Queries, tenantID utilities.ID) error {
	if err := queries.EnsureWebhookTenantState(ctx, uuid(tenantID)); err != nil {
		return err
	}
	return queries.LockWebhookTenantState(ctx, uuid(tenantID))
}
