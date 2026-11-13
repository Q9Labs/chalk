package postgres

import (
	"context"
	"errors"
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
	patch := &endpointPatch{
		repo: r, tx: tx, queries: sqlc.New(tx), tenantID: tenantID, endpointID: endpointID,
		input: input, normalizedURL: normalizedURL, redactedURL: redactedURL,
	}
	result, err := patch.run(ctx)
	if err != nil {
		return webhooks.Endpoint{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return webhooks.Endpoint{}, err
	}
	webhooks.RecordTerminalDeliveries(ctx, "canceled", patch.canceled)
	return result, nil
}

// endpointPatch is one Patch transaction: the endpoint row it read and the deliveries it canceled.
type endpointPatch struct {
	repo          WebhookRepository
	tx            pgx.Tx
	queries       *sqlc.Queries
	tenantID      utilities.ID
	endpointID    utilities.ID
	input         webhooks.PatchInput
	normalizedURL string
	redactedURL   string
	current       sqlc.GetWebhookEndpointRow
	canceled      int64
}

func (p *endpointPatch) run(ctx context.Context) (webhooks.Endpoint, error) {
	if err := lockWebhookTenant(ctx, p.queries, p.tenantID); err != nil {
		return webhooks.Endpoint{}, err
	}
	hashInput := p.input
	hashInput.IdempotencyKey = ""
	hash := idempotencyHash(struct {
		Endpoint string
		Patch    webhooks.PatchInput
	}{p.endpointID.String(), hashInput})
	if cached, ok, err := p.repo.replayIdempotency(ctx, p.tx, p.tenantID, "endpoint.patch", p.input.IdempotencyKey, hash); err != nil {
		return webhooks.Endpoint{}, err
	} else if ok {
		return cached.Endpoint.domain(), nil
	}
	if err := p.loadCurrent(ctx); err != nil {
		return webhooks.Endpoint{}, err
	}
	name, enabled := p.current.Name, p.current.Enabled
	if p.input.Name != nil {
		name = *p.input.Name
	}
	if p.input.Enabled != nil {
		enabled = *p.input.Enabled
	}
	targetChanged, err := p.targetChanged()
	if err != nil {
		return webhooks.Endpoint{}, err
	}
	targetRevision := p.current.CurrentTargetRevision
	if targetChanged {
		targetRevision++
		if err := p.insertTargetRevision(ctx, targetRevision); err != nil {
			return webhooks.Endpoint{}, err
		}
	}
	if err := p.update(ctx, name, enabled, targetRevision); err != nil {
		return webhooks.Endpoint{}, err
	}
	if targetChanged {
		if err := p.retireOldTargets(ctx, targetRevision); err != nil {
			return webhooks.Endpoint{}, err
		}
	}
	if !enabled {
		if err := cancelWebhookDeliveries(ctx, p.tx, p.tenantID, p.endpointID, nil, "endpoint_disabled", &p.canceled); err != nil {
			return webhooks.Endpoint{}, err
		}
	}
	finalRow, err := p.queries.GetWebhookEndpoint(ctx, sqlc.GetWebhookEndpointParams{TenantID: uuid(p.tenantID), EndpointID: uuid(p.endpointID)})
	if err != nil {
		return webhooks.Endpoint{}, err
	}
	result := mapGetWebhookEndpoint(finalRow)
	if err := p.repo.storeIdempotency(ctx, p.tx, p.tenantID, "endpoint.patch", p.input.IdempotencyKey, hash, 200, p.endpointID, webhookIdempotencyResponse{Endpoint: cacheEndpoint(result)}); err != nil {
		return webhooks.Endpoint{}, err
	}
	return result, nil
}

func (p *endpointPatch) loadCurrent(ctx context.Context) error {
	current, err := p.queries.GetWebhookEndpoint(ctx, sqlc.GetWebhookEndpointParams{TenantID: uuid(p.tenantID), EndpointID: uuid(p.endpointID)})
	if errors.Is(err, pgx.ErrNoRows) {
		return webhooks.ErrEndpointNotFound
	}
	if err != nil {
		return err
	}
	if int(current.Revision) != p.input.ExpectedRevision {
		return webhooks.ErrRevisionConflict
	}
	p.current = current
	return nil
}

// currentURL decrypts the URL stored on the revision the endpoint points at.
func (p *endpointPatch) currentURL() ([]byte, error) {
	if p.repo.protector == nil {
		return nil, webhooks.ErrEncryptionUnavailable
	}
	return p.repo.protector.Unprotect(webhooks.URLScope(p.tenantID, p.endpointID, id(p.current.TargetRevisionID)), p.current.UrlCiphertext)
}

// targetChanged reports whether the patch changes the URL, API version or event types, which all
// need a new target revision.
func (p *endpointPatch) targetChanged() (bool, error) {
	urlChanged := false
	if p.input.URL != nil {
		plaintextURL, err := p.currentURL()
		if err != nil {
			return false, err
		}
		urlChanged = string(plaintextURL) != p.normalizedURL
	}
	apiVersionChanged := p.input.APIVersion != nil && int(p.current.ApiVersion) != *p.input.APIVersion
	eventTypesChanged := p.input.EventTypes != nil && !slices.Equal(p.current.EventTypes, *p.input.EventTypes)
	return urlChanged || apiVersionChanged || eventTypesChanged, nil
}

func (p *endpointPatch) insertTargetRevision(ctx context.Context, revision int32) error {
	revisionID, err := utilities.NewID()
	if err != nil {
		return err
	}
	scope := webhooks.URLScope(p.tenantID, p.endpointID, revisionID)
	var encryptedURL []byte
	redactedURL := p.redactedURL
	if p.input.URL == nil {
		plaintextURL, err := p.currentURL()
		if err != nil {
			return err
		}
		encryptedURL, err = p.repo.protector.Protect(scope, plaintextURL)
		if err != nil {
			return err
		}
		redactedURL = p.current.UrlRedacted
	} else {
		encryptedURL, err = p.repo.protector.Protect(scope, []byte(p.normalizedURL))
		if err != nil {
			return err
		}
	}
	apiVersion := p.current.ApiVersion
	if p.input.APIVersion != nil {
		apiVersion = int32(*p.input.APIVersion)
	}
	eventTypes := p.current.EventTypes
	if p.input.EventTypes != nil {
		eventTypes = *p.input.EventTypes
	}
	_, err = p.queries.InsertWebhookEndpointRevision(ctx, sqlc.InsertWebhookEndpointRevisionParams{
		ID: uuid(revisionID), TenantID: uuid(p.tenantID), EndpointID: uuid(p.endpointID), Revision: revision,
		UrlCiphertext: encryptedURL, UrlRedacted: redactedURL, ApiVersion: apiVersion, EventTypes: eventTypes,
	})
	return err
}

func (p *endpointPatch) update(ctx context.Context, name string, enabled bool, targetRevision int32) error {
	_, err := p.queries.UpdateWebhookEndpoint(ctx, sqlc.UpdateWebhookEndpointParams{
		Name: name, Enabled: enabled, CurrentTargetRevision: targetRevision, TenantID: uuid(p.tenantID),
		EndpointID: uuid(p.endpointID), ExpectedRevision: int32(p.input.ExpectedRevision),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return webhooks.ErrRevisionConflict
	}
	return err
}

// retireOldTargets cancels deliveries that still point at an older target and destroys the old URLs.
func (p *endpointPatch) retireOldTargets(ctx context.Context, targetRevision int32) error {
	if err := cancelWebhookDeliveries(ctx, p.tx, p.tenantID, p.endpointID, &targetRevision, "target_replaced", &p.canceled); err != nil {
		return err
	}
	_, err := p.queries.DestroyOldWebhookTargetURLs(ctx, sqlc.DestroyOldWebhookTargetURLsParams{TenantID: uuid(p.tenantID), EndpointID: uuid(p.endpointID), CurrentTargetRevision: targetRevision})
	return err
}
