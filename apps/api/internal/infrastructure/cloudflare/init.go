package cloudflare

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
)

var (
	CLOUDFLARE_WEBHOOK_LOOKUP_FAILED = errors.New("cloudflare: failed to list cloudflare webhooks")
	NO_WEBHOOKS_CONFIGURED           = errors.New("cloudflare: NO CLOUDFLARE WEBHOOK CONFIGURED - recordings will not be processed")
	WEBHOOK_DISABLED                 = errors.New("cloudflare: webhook exists but is disabled")
)

// setup webhook for recording.ready events
func InitCloudflareWebhook(ctx context.Context, cfClient *Client) (bool, error) {
	webhooks, err := cfClient.ListWebhooks(ctx)
	if err != nil {
		slog.Warn("failed to list cloudflare webhooks", "error", err)
		return false, fmt.Errorf("%w: %w ", CLOUDFLARE_WEBHOOK_LOOKUP_FAILED, err)
	}

	if len(webhooks) == 0 {
		slog.Error("NO CLOUDFLARE WEBHOOK CONFIGURED - recordings will not be processed",
			"action", "run 'go run ./cmd/setup-webhook' to configure")
		return false, NO_WEBHOOKS_CONFIGURED
	}
	var activeWebhook *Webhook
	for i := range webhooks {
		if webhooks[i].Enabled {
			activeWebhook = &webhooks[i]
			break
		}
	}
	if activeWebhook == nil {
		slog.Warn("cloudflare webhook exists but is disabled",
			"webhook_count", len(webhooks))
		return false, WEBHOOK_DISABLED
	}

	slog.Info("cloudflare webhook configured",
		"webhook_id", activeWebhook.ID,
		"url", activeWebhook.URL,
		"events", activeWebhook.Events)
	return true, nil
}
