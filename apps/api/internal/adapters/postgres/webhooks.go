package postgres

import (
	"context"
	"errors"
	"fmt"
	"slices"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"github.com/q9labs/chalk/apps/api/internal/webhooks"
)

type WebhookRepository struct {
	pool      *pgxpool.Pool
	protector webhooks.SecretProtector
}

func NewWebhookRepository(pool *pgxpool.Pool, protectors ...webhooks.SecretProtector) WebhookRepository {
	var protector webhooks.SecretProtector
	if len(protectors) > 0 {
		protector = protectors[0]
	}
	return WebhookRepository{pool: pool, protector: protector}
}

func (r WebhookRepository) Create(ctx context.Context, input webhooks.CreateInput) (webhooks.CreateResult, error) {
	if r.protector == nil {
		return webhooks.CreateResult{}, webhooks.ErrEncryptionUnavailable
	}
	_, redactedURL, _ := webhooks.ValidateEndpointURL(input.URL)
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return webhooks.CreateResult{}, fmt.Errorf("begin webhook endpoint create: %w", err)
	}
	defer tx.Rollback(ctx)
	queries := sqlc.New(tx)
	if err := lockWebhookTenant(ctx, queries, input.TenantID); err != nil {
		return webhooks.CreateResult{}, err
	}
	hash := idempotencyHash(struct {
		Name, URL  string
		Enabled    bool
		APIVersion int
		EventTypes []string
	}{input.Name, input.URL, input.Enabled, input.APIVersion, input.EventTypes})
	if cached, ok, err := r.replayIdempotency(ctx, tx, input.TenantID, "endpoint.create", input.IdempotencyKey, hash); err != nil {
		return webhooks.CreateResult{}, err
	} else if ok {
		return webhooks.CreateResult{Endpoint: cached.Endpoint.domain(), Secret: cached.Secret}, nil
	}
	count, err := queries.CountWebhookEndpoints(ctx, uuid(input.TenantID))
	if err != nil {
		return webhooks.CreateResult{}, fmt.Errorf("count webhook endpoints: %w", err)
	}
	if count >= webhooks.MaxEndpointsPerTenant {
		return webhooks.CreateResult{}, webhooks.ErrEndpointLimitReached
	}
	endpointID, err := utilities.NewID()
	if err != nil {
		return webhooks.CreateResult{}, err
	}
	revisionID, err := utilities.NewID()
	if err != nil {
		return webhooks.CreateResult{}, err
	}
	secret, rawSecret, err := webhooks.NewSigningSecret()
	if err != nil {
		return webhooks.CreateResult{}, err
	}
	secretCiphertext, err := r.protector.Protect(webhooks.SecretScope(input.TenantID, endpointID), rawSecret)
	if err != nil {
		return webhooks.CreateResult{}, err
	}
	urlCiphertext, err := r.protector.Protect(webhooks.URLScope(input.TenantID, endpointID, revisionID), []byte(input.URL))
	if err != nil {
		return webhooks.CreateResult{}, err
	}
	row, err := queries.InsertWebhookEndpoint(ctx, sqlc.InsertWebhookEndpointParams{ID: uuid(endpointID), TenantID: uuid(input.TenantID), Name: input.Name, Enabled: input.Enabled, CurrentSecretCiphertext: secretCiphertext, CreatedByUserID: uuid(input.CreatedByUserID)})
	if err != nil {
		return webhooks.CreateResult{}, fmt.Errorf("insert webhook endpoint: %w", err)
	}
	revision, err := queries.InsertWebhookEndpointRevision(ctx, sqlc.InsertWebhookEndpointRevisionParams{ID: uuid(revisionID), TenantID: uuid(input.TenantID), EndpointID: uuid(endpointID), Revision: 1, UrlCiphertext: urlCiphertext, UrlRedacted: redactedURL, ApiVersion: webhooks.APIVersion, EventTypes: input.EventTypes})
	if err != nil {
		return webhooks.CreateResult{}, fmt.Errorf("insert webhook endpoint revision: %w", err)
	}
	result := webhooks.CreateResult{Endpoint: mapWebhookEndpoint(row, revision.UrlRedacted, revision.ApiVersion, revision.EventTypes), Secret: secret}
	if err := insertWebhookAudit(ctx, tx, input.TenantID, "webhook_endpoint.create", "webhook_endpoint", endpointID, map[string]any{"api_version": input.APIVersion, "enabled": input.Enabled, "event_type_count": len(input.EventTypes), "revision": 1}); err != nil {
		return webhooks.CreateResult{}, err
	}
	if err := r.storeIdempotency(ctx, tx, input.TenantID, "endpoint.create", input.IdempotencyKey, hash, 201, result.Endpoint.ID, webhookIdempotencyResponse{Endpoint: cacheEndpoint(result.Endpoint), Secret: secret}); err != nil {
		return webhooks.CreateResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return webhooks.CreateResult{}, fmt.Errorf("commit webhook endpoint create: %w", err)
	}
	return result, nil
}

func (r WebhookRepository) Get(ctx context.Context, tenantID, endpointID utilities.ID) (webhooks.Endpoint, error) {
	row, err := sqlc.New(r.pool).GetWebhookEndpoint(ctx, sqlc.GetWebhookEndpointParams{TenantID: uuid(tenantID), EndpointID: uuid(endpointID)})
	if errors.Is(err, pgx.ErrNoRows) {
		return webhooks.Endpoint{}, webhooks.ErrEndpointNotFound
	}
	if err != nil {
		return webhooks.Endpoint{}, fmt.Errorf("get webhook endpoint: %w", err)
	}
	return mapGetWebhookEndpoint(row), nil
}

func (r WebhookRepository) List(ctx context.Context, tenantID utilities.ID, page pagination.PageRequest) (webhooks.EndpointList, error) {
	params := sqlc.ListWebhookEndpointsParams{TenantID: uuid(tenantID), PageSize: int32(page.Size() + 1)}
	if cursor := page.Cursor(); cursor != nil {
		params.CursorSet = true
		params.CursorCreatedAt = timestamptz(&cursor.CreatedAt)
		params.CursorID = uuid(cursor.ID)
	}
	rows, err := sqlc.New(r.pool).ListWebhookEndpoints(ctx, params)
	if err != nil {
		return webhooks.EndpointList{}, fmt.Errorf("list webhook endpoints: %w", err)
	}
	hasMore := len(rows) > page.Size()
	if hasMore {
		rows = rows[:page.Size()]
	}
	list := webhooks.EndpointList{Endpoints: make([]webhooks.Endpoint, 0, len(rows)), Page: pagination.Page{PageSize: page.Size(), HasMore: hasMore}}
	for _, row := range rows {
		list.Endpoints = append(list.Endpoints, webhooks.Endpoint{ID: id(row.ID), TenantID: id(row.TenantID), Name: row.Name, URLRedacted: row.UrlRedacted, Enabled: row.Enabled, Revision: int(row.Revision), APIVersion: int(row.ApiVersion), EventTypes: row.EventTypes, CreatedAt: timestamp(row.CreatedAt), UpdatedAt: timestamp(row.UpdatedAt)})
	}
	if hasMore {
		last := list.Endpoints[len(list.Endpoints)-1]
		list.Page.NextCursor = &pagination.Cursor{CreatedAt: last.CreatedAt, ID: last.ID}
	}
	return list, nil
}

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
	auditAction := "webhook_endpoint.update"
	if current.Enabled && !enabled {
		auditAction = "webhook_endpoint.disable"
	}
	if err := insertWebhookAudit(ctx, tx, tenantID, auditAction, "webhook_endpoint", endpointID, map[string]any{"enabled": enabled, "enabled_changed": current.Enabled != enabled, "revision": result.Revision, "target_changed": targetChanged}); err != nil {
		return webhooks.Endpoint{}, err
	}
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
	queries := sqlc.New(tx)
	if err := lockWebhookTenant(ctx, queries, tenantID); err != nil {
		return err
	}
	hash := idempotencyHash(struct {
		Endpoint string
		Revision int
	}{endpointID.String(), revision})
	if _, ok, err := r.replayIdempotency(ctx, tx, tenantID, "endpoint.delete", key, hash); err != nil {
		return err
	} else if ok {
		return nil
	}
	var currentRevision int32
	var deleted bool
	err = tx.QueryRow(ctx, `select revision,deleted_at is not null from webhook_endpoints where tenant_id=$1 and id=$2 for update`, uuid(tenantID), uuid(endpointID)).Scan(&currentRevision, &deleted)
	if errors.Is(err, pgx.ErrNoRows) || deleted {
		return webhooks.ErrEndpointNotFound
	}
	if err != nil {
		return err
	}
	if currentRevision != int32(revision) {
		return webhooks.ErrRevisionConflict
	}
	_, err = queries.DeleteWebhookEndpoint(ctx, sqlc.DeleteWebhookEndpointParams{TenantID: uuid(tenantID), EndpointID: uuid(endpointID), ExpectedRevision: int32(revision)})
	if errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("delete webhook endpoint after locked revision check: %w", err)
	}
	if err != nil {
		return err
	}
	var canceledCount int64
	err = cancelWebhookDeliveries(ctx, tx, tenantID, endpointID, nil, "endpoint_deleted", &canceledCount)
	if err == nil {
		_, err = queries.DestroyWebhookEndpointURLs(ctx, sqlc.DestroyWebhookEndpointURLsParams{TenantID: uuid(tenantID), EndpointID: uuid(endpointID)})
	}
	if err != nil {
		return err
	}
	if err := insertWebhookAudit(ctx, tx, tenantID, "webhook_endpoint.delete", "webhook_endpoint", endpointID, map[string]any{"revision": revision + 1}); err != nil {
		return err
	}
	if err := r.storeIdempotency(ctx, tx, tenantID, "endpoint.delete", key, hash, 204, endpointID, webhookIdempotencyResponse{}); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	webhooks.RecordTerminalDeliveries(ctx, "canceled", canceledCount)
	return nil
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
	if err := insertWebhookAudit(ctx, tx, tenantID, "webhook_endpoint.rotate_secret", "webhook_endpoint", endpointID, map[string]any{"previous_revoked_immediately": immediate, "revision": result.Revision}); err != nil {
		return webhooks.RotateResult{}, err
	}
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

func mapWebhookEndpoint(row sqlc.WebhookEndpoint, redacted string, apiVersion int32, eventTypes []string) webhooks.Endpoint {
	return webhooks.Endpoint{ID: id(row.ID), TenantID: id(row.TenantID), Name: row.Name, URLRedacted: redacted, Enabled: row.Enabled, Revision: int(row.Revision), APIVersion: int(apiVersion), EventTypes: eventTypes, CreatedAt: timestamp(row.CreatedAt), UpdatedAt: timestamp(row.UpdatedAt)}
}
func mapGetWebhookEndpoint(row sqlc.GetWebhookEndpointRow) webhooks.Endpoint {
	return webhooks.Endpoint{ID: id(row.ID), TenantID: id(row.TenantID), Name: row.Name, URLRedacted: row.UrlRedacted, Enabled: row.Enabled, Revision: int(row.Revision), APIVersion: int(row.ApiVersion), EventTypes: row.EventTypes, CreatedAt: timestamp(row.CreatedAt), UpdatedAt: timestamp(row.UpdatedAt)}
}
func id(value pgtype.UUID) utilities.ID { return utilities.IDFromBytes(value.Bytes) }

var _ webhooks.Repository = WebhookRepository{}
