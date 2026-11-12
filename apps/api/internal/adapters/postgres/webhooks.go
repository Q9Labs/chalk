package postgres

import (
	"context"
	"errors"
	"fmt"

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

func mapWebhookEndpoint(row sqlc.WebhookEndpoint, redacted string, apiVersion int32, eventTypes []string) webhooks.Endpoint {
	return webhooks.Endpoint{ID: id(row.ID), TenantID: id(row.TenantID), Name: row.Name, URLRedacted: redacted, Enabled: row.Enabled, Revision: int(row.Revision), APIVersion: int(apiVersion), EventTypes: eventTypes, CreatedAt: timestamp(row.CreatedAt), UpdatedAt: timestamp(row.UpdatedAt)}
}
func mapGetWebhookEndpoint(row sqlc.GetWebhookEndpointRow) webhooks.Endpoint {
	return webhooks.Endpoint{ID: id(row.ID), TenantID: id(row.TenantID), Name: row.Name, URLRedacted: row.UrlRedacted, Enabled: row.Enabled, Revision: int(row.Revision), APIVersion: int(row.ApiVersion), EventTypes: row.EventTypes, CreatedAt: timestamp(row.CreatedAt), UpdatedAt: timestamp(row.UpdatedAt)}
}
func id(value pgtype.UUID) utilities.ID { return utilities.IDFromBytes(value.Bytes) }

var _ webhooks.Repository = WebhookRepository{}
